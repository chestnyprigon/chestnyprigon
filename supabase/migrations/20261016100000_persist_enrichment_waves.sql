begin;

create table public.chestny_enrichment_waves (
  id uuid primary key default extensions.gen_random_uuid(),
  run_id uuid not null references public.chestny_enrichment_runs(id) on delete cascade,
  wave_number integer not null check (wave_number > 0),
  candidate_count integer not null check (candidate_count > 0),
  status text not null default 'queued'
    check (status in ('queued','enriching','enriched','screening','ready','paused','completed')),
  plan jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  enrichment_completed_at timestamptz,
  screening_completed_at timestamptz,
  completed_at timestamptz,
  last_error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, wave_number),
  unique (id, run_id)
);

alter table public.chestny_enrichment_queue
  add column wave_id uuid,
  add column wave_position integer;

alter table public.chestny_enrichment_queue
  add constraint chestny_enrichment_queue_wave_run_fk
  foreign key (wave_id, run_id)
  references public.chestny_enrichment_waves(id, run_id)
  on delete restrict;

alter table public.chestny_enrichment_queue
  add constraint chestny_enrichment_queue_wave_position_check
  check ((wave_id is null and wave_position is null) or (wave_id is not null and wave_position > 0));

create unique index chestny_enrichment_queue_wave_position_uidx
  on public.chestny_enrichment_queue (wave_id, wave_position)
  where wave_id is not null;

create index chestny_enrichment_queue_wave_status_idx
  on public.chestny_enrichment_queue (run_id, wave_id, status, wave_position);

alter table public.chestny_enrichment_waves enable row level security;
revoke all on public.chestny_enrichment_waves from anon, authenticated;
grant all on public.chestny_enrichment_waves to service_role;

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

revoke all on function public.plan_chestny_enrichment_waves(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.plan_chestny_enrichment_waves(uuid, integer, jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
