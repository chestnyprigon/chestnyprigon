begin;

create or replace function public.claim_chestny_enrichment_wave(
  p_run_id uuid,
  p_wave_id uuid,
  p_limit integer,
  p_lease_minutes integer default 15
) returns setof public.chestny_enrichment_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_status text;
  v_wave_status text;
begin
  if p_limit is null or p_limit < 1 or p_lease_minutes is null or p_lease_minutes < 1 then
    raise exception 'Claim limit and lease duration must be positive integers';
  end if;

  select r.status into v_run_status
  from public.chestny_enrichment_runs r
  where r.id = p_run_id;
  if not found or v_run_status not in ('approved', 'running') then
    raise exception 'Run is not eligible for enrichment';
  end if;

  select w.status into v_wave_status
  from public.chestny_enrichment_waves w
  where w.id = p_wave_id and w.run_id = p_run_id
  for update;
  if not found then raise exception 'Wave does not belong to the supplied run'; end if;
  if v_wave_status not in ('queued', 'enriching', 'paused') then
    raise exception 'Wave is not open for enrichment';
  end if;

  update public.chestny_enrichment_waves
  set status = 'enriching', started_at = coalesce(started_at, now()), updated_at = now()
  where id = p_wave_id and run_id = p_run_id;

  return query
  with candidates as (
    select q.id
    from public.chestny_enrichment_queue q
    where q.run_id = p_run_id
      and q.wave_id = p_wave_id
      and (q.status = 'queued' or (q.status = 'leased' and q.lease_until < now()))
    order by q.wave_position
    for update skip locked
    limit p_limit
  )
  update public.chestny_enrichment_queue q
  set status = 'leased',
      attempt_count = q.attempt_count + 1,
      last_attempt_at = now(),
      lease_until = now() + make_interval(mins => p_lease_minutes),
      updated_at = now()
  from candidates c
  where q.id = c.id
  returning q.*;
end;
$$;

create or replace function public.guard_chestny_enrichment_wave_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform r.id
    from public.chestny_enrichment_runs r
    where r.id = new.run_id
    for update;
    if exists (select 1 from public.chestny_enrichment_waves w where w.run_id = new.run_id) then
      raise exception 'Cannot add candidates after the run wave manifest is frozen';
    end if;
    return new;
  end if;

  if old.wave_id is not null and (
    new.run_id is distinct from old.run_id
    or new.source_listing_id is distinct from old.source_listing_id
    or new.wave_id is distinct from old.wave_id
    or new.wave_position is distinct from old.wave_position
  ) then
    raise exception 'Persisted enrichment wave membership is immutable';
  end if;
  return new;
end;
$$;

create or replace function public.guard_chestny_enrichment_wave_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.run_id is distinct from old.run_id
    or new.wave_number is distinct from old.wave_number
    or new.candidate_count is distinct from old.candidate_count
    or new.plan is distinct from old.plan
  ) then
    raise exception 'Persisted enrichment wave plan is immutable';
  end if;
  if tg_op = 'DELETE' and exists (
    select 1 from public.chestny_enrichment_queue q where q.wave_id = old.id
  ) then
    raise exception 'Cannot delete a wave that still contains candidates';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- Once a run has a wave manifest, legacy callers must not claim its rows.
create or replace function public.claim_chestny_enrichment_queue(
  p_run_id uuid,
  p_limit integer,
  p_lease_minutes integer
)
returns setof public.chestny_enrichment_queue
language sql
security definer
set search_path = ''
as $$
  with picked as (
    select q.id
    from public.chestny_enrichment_queue q
    where q.run_id = p_run_id
      and q.wave_id is null
      and q.status in ('queued', 'leased')
      and (q.status = 'queued' or q.lease_until is null or q.lease_until < now())
    order by q.created_at
    for update skip locked
    limit greatest(1, least(p_limit, 50))
  )
  update public.chestny_enrichment_queue q
  set status = 'leased',
      lease_until = now() + make_interval(mins => greatest(5, least(p_lease_minutes, 120))),
      last_attempt_at = now(),
      attempt_count = q.attempt_count + 1,
      updated_at = now()
  from picked
  where q.id = picked.id
  returning q.*;
$$;

-- Serialize planning against legacy queue claims. If a worker claimed even one
-- item first, the all-queued precondition fails and the run stays unplanned.
create or replace function public.plan_chestny_enrichment_waves(
  p_run_id uuid,
  p_safe_wave_capacity integer,
  p_plan jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_total integer;
  v_wave_count integer;
  v_index integer;
  v_base integer;
  v_extra integer;
  v_wave_id uuid;
  v_created integer := 0;
  v_summary jsonb;
begin
  if p_safe_wave_capacity is null or p_safe_wave_capacity < 1 then
    raise exception 'Wave capacity must be a positive integer';
  end if;
  if jsonb_typeof(coalesce(p_plan, '{}'::jsonb)) <> 'object' then
    raise exception 'Wave plan metadata must be a JSON object';
  end if;

  select r.status into v_status
  from public.chestny_enrichment_runs r
  where r.id = p_run_id
  for update;
  if not found then raise exception 'Enrichment run not found'; end if;
  if v_status <> 'approved' then
    raise exception 'Wave plan can only be created for an approved, not-yet-started run';
  end if;
  perform q.id
  from public.chestny_enrichment_queue q
  where q.run_id = p_run_id
  order by q.id
  for update;
  if exists (select 1 from public.chestny_enrichment_waves w where w.run_id = p_run_id)
    or exists (select 1 from public.chestny_enrichment_queue q where q.run_id = p_run_id and q.wave_id is not null) then
    raise exception 'Wave plan already exists for this run';
  end if;
  if exists (select 1 from public.chestny_enrichment_queue q where q.run_id = p_run_id and q.status <> 'queued') then
    raise exception 'All candidates must still be queued before planning waves';
  end if;

  select count(*)::integer into v_total
  from public.chestny_enrichment_queue q
  where q.run_id = p_run_id;
  if v_total = 0 then raise exception 'Cannot plan waves for an empty queue'; end if;

  v_wave_count := ceil(v_total::numeric / p_safe_wave_capacity)::integer;
  v_base := v_total / v_wave_count;
  v_extra := v_total % v_wave_count;
  for v_index in 1..v_wave_count loop
    insert into public.chestny_enrichment_waves(run_id, wave_number, candidate_count, plan)
    values (
      p_run_id,
      v_index,
      v_base + case when v_index <= v_extra then 1 else 0 end,
      coalesce(p_plan, '{}'::jsonb) || jsonb_build_object(
        'totalCandidates', v_total,
        'waveCount', v_wave_count,
        'safeWaveCapacity', p_safe_wave_capacity,
        'distribution', 'balanced_by_candidate_count'
      )
    ) returning id into v_wave_id;
    v_created := v_created + 1;
  end loop;

  with numbered as (
    select q.id,
      row_number() over (order by q.created_at, q.source_listing_id)::integer as run_position
    from public.chestny_enrichment_queue q
    where q.run_id = p_run_id
  ), assigned as (
    select n.id,
      floor(((n.run_position - 1)::numeric * v_wave_count) / v_total)::integer + 1 as wave_number,
      row_number() over (
        partition by floor(((n.run_position - 1)::numeric * v_wave_count) / v_total)::integer + 1
        order by n.run_position
      )::integer as wave_position
    from numbered n
  )
  update public.chestny_enrichment_queue q
  set wave_id = w.id, wave_position = a.wave_position, updated_at = now()
  from assigned a
  join public.chestny_enrichment_waves w
    on w.run_id = p_run_id and w.wave_number = a.wave_number
  where q.id = a.id;

  select jsonb_build_object(
    'runId', p_run_id,
    'candidateCount', v_total,
    'waveCount', v_created,
    'waves', coalesce(jsonb_agg(jsonb_build_object(
      'waveId', w.id,
      'waveNumber', w.wave_number,
      'candidateCount', w.candidate_count
    ) order by w.wave_number), '[]'::jsonb)
  ) into v_summary
  from public.chestny_enrichment_waves w
  where w.run_id = p_run_id;
  return v_summary;
end;
$$;

revoke all on function public.claim_chestny_enrichment_queue(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_chestny_enrichment_queue(uuid, integer, integer) to service_role;
revoke all on function public.plan_chestny_enrichment_waves(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.plan_chestny_enrichment_waves(uuid, integer, jsonb) to service_role;

drop trigger if exists chestny_enrichment_wave_membership_guard on public.chestny_enrichment_queue;
create trigger chestny_enrichment_wave_membership_guard
before insert or update on public.chestny_enrichment_queue
for each row execute function public.guard_chestny_enrichment_wave_membership();

drop trigger if exists chestny_enrichment_wave_plan_guard on public.chestny_enrichment_waves;
create trigger chestny_enrichment_wave_plan_guard
before update or delete on public.chestny_enrichment_waves
for each row execute function public.guard_chestny_enrichment_wave_plan();

revoke all on function public.claim_chestny_enrichment_wave(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_chestny_enrichment_wave(uuid, uuid, integer, integer) to service_role;
revoke all on function public.guard_chestny_enrichment_wave_membership() from public, anon, authenticated;
revoke all on function public.guard_chestny_enrichment_wave_plan() from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
