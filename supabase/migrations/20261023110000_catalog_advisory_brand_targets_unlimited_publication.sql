begin;

-- Publication brand targets are diversity guidance. They are not hard caps.
create or replace function public.enforce_vehicle_publication()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.listing_screening;
  v_new_publication boolean;
begin
  if not new.is_public then return new; end if;

  select * into s
  from public.listing_screening
  where source_listing_id = new.source_listing_id
  for share;
  if s.source_listing_id is null or s.decision <> 'approved'
    or s.is_lease or s.is_rental or s.is_taxi or s.is_commercial or s.is_problematic then
    raise exception 'Listing % has not passed publication screening', new.source_listing_id;
  end if;

  v_new_publication := tg_op = 'INSERT';
  if tg_op = 'UPDATE' then
    v_new_publication := not old.is_public or old.source_listing_id <> new.source_listing_id
      or old.catalog_launch_id is distinct from new.catalog_launch_id;
    if old.catalog_launch_id is not null and (old.catalog_launch_id is distinct from new.catalog_launch_id
      or old.manufacturer <> new.manufacturer) then
      raise exception 'Publication launch and credited brand are immutable';
    end if;
  end if;

  if v_new_publication then
    if s.rules_version is null
      or s.rules_version is distinct from s.details->'publicationGate'->>'version'
      or s.details->'publicationGate'->>'validated' is distinct from 'true'
      or s.details->'publicationGate'->>'canonicalId' is distinct from new.source_listing_id then
      raise exception 'Listing % requires a current integrity gate', new.source_listing_id;
    end if;
    if new.model_year < 2016 or new.mileage_km > 190000 or new.price_krw <= 0 or new.price_usd is null
      or new.engine_cc is null or new.engine_cc <= 0 then
      raise exception 'Catalogue characteristics are incomplete';
    end if;
    if new.source_updated_at is null or new.source_updated_at < now() - interval '180 days' then
      raise exception 'Listing freshness unconfirmed';
    end if;
    if s.details->'publicationGate'->'normalized' is distinct from jsonb_build_object(
      'manufacturer', new.manufacturer, 'model', new.model, 'modelYear', new.model_year,
      'mileageKm', new.mileage_km, 'engineCc', new.engine_cc, 'fuelType', new.fuel_type,
      'transmission', new.transmission, 'priceKrw', new.price_krw) then
      raise exception 'Normalized catalogue fields conflict with validated payload';
    end if;
    if (select count(*) from public.vehicle_images where vehicle_id = new.id) < 5 then
      raise exception 'Catalogue requires five photographs';
    end if;
    if not exists (select 1 from public.vehicle_reports where vehicle_id = new.id
      and canonical_vehicle_id = new.source_listing_id and report_status in ('ready', 'unavailable')) then
      raise exception 'Report result is not confirmed';
    end if;
  end if;

  if new.catalog_launch_id is not null and v_new_publication then
    if not exists (select 1 from public.chestny_catalog_launches where id = new.catalog_launch_id
      and status in ('prepared', 'running')) then
      raise exception 'Launch is not active';
    end if;
    if exists (select 1 from public.chestny_catalog_launch_baseline_identifiers
      where launch_id = new.catalog_launch_id and source_identifier = new.source_listing_id) then
      raise exception 'Existing baseline listing cannot be counted as new';
    end if;
    if not exists (select 1 from public.chestny_catalog_launch_quotas
      where launch_id = new.catalog_launch_id and manufacturer = new.manufacturer) then
      raise exception 'Brand is not included in the launch diversity guidance';
    end if;
  end if;

  new.published_at = coalesce(new.published_at, now());
  return new;
end;
$$;

create or replace function public.prepare_chestny_catalog_launch(
  p_name text,
  p_quotas jsonb,
  p_rules jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_counts jsonb;
  v_brand_count integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_name));
  select id into v_id from public.chestny_catalog_launches where name = p_name;
  if v_id is not null then
    if exists (select 1 from public.chestny_catalog_launches where id = v_id and status <> 'prepared') then
      raise exception 'Launch baseline capture is incomplete';
    end if;
    insert into public.chestny_catalog_brand_search_progress(launch_id, manufacturer)
      select v_id, manufacturer from public.chestny_catalog_launch_quotas where launch_id = v_id
      on conflict (launch_id, manufacturer) do nothing;
    return v_id;
  end if;

  if jsonb_typeof(p_quotas) <> 'array' or jsonb_array_length(p_quotas) = 0 then
    raise exception 'Brand diversity guidance must contain at least one brand';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_quotas) as q(manufacturer text, target integer)
    where coalesce(trim(q.manufacturer), '') = '' or q.target is null or q.target <= 0
  ) then raise exception 'Brand guidance requires a name and a positive integer weight'; end if;
  select count(distinct q.manufacturer) into v_brand_count
    from jsonb_to_recordset(p_quotas) as q(manufacturer text, target integer);
  if v_brand_count <> jsonb_array_length(p_quotas) then
    raise exception 'Brand diversity guidance must not contain duplicate brands';
  end if;

  select jsonb_build_object(
    'publicActive', (select count(*) from public.vehicles where is_public and status = 'active'),
    'publicByBrand', (select jsonb_object_agg(manufacturer, n) from
      (select manufacturer, count(*) n from public.vehicles where is_public and status = 'active' group by manufacturer) b),
    'queue', (select jsonb_object_agg(status, n) from (select status, count(*) n from public.chestny_enrichment_queue group by status) q),
    'staging', (select jsonb_object_agg(enrichment_status, n) from
      (select enrichment_status, count(*) n from public.chestny_catalog_staging group by enrichment_status) s),
    'newPublicationsRule', 'Unique canonical IDs not present in the baseline, explicitly attached to this launch, and passing the publication gate; brand targets are diversity guidance only; no overall or per-brand publication cap'
  ) into v_counts;

  insert into public.chestny_catalog_launches(name, rules, baseline_counts)
    values (p_name, coalesce(p_rules, '{}'::jsonb), v_counts) returning id into v_id;
  insert into public.chestny_catalog_launch_quotas(launch_id, manufacturer, target, baseline_public_count)
    select v_id, q.manufacturer, q.target,
      coalesce((v_counts->'publicByBrand'->>q.manufacturer)::integer, 0)
    from jsonb_to_recordset(p_quotas) as q(manufacturer text, target integer);
  insert into public.chestny_catalog_brand_search_progress(launch_id, manufacturer)
    select v_id, manufacturer from public.chestny_catalog_launch_quotas where launch_id = v_id
    on conflict (launch_id, manufacturer) do nothing;
  return v_id;
end;
$$;

create or replace function public.start_chestny_catalog_brand_search(p_launch uuid, p_manufacturer text, p_run uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.chestny_catalog_launch_quotas
    where launch_id = p_launch and manufacturer = p_manufacturer) then
    raise exception 'Manufacturer has no diversity guidance entry';
  end if;
  update public.chestny_catalog_brand_search_progress
    set run_id = p_run, status = 'searching', last_error = null, updated_at = now()
    where launch_id = p_launch and manufacturer = p_manufacturer;
  if not found then raise exception 'Brand search progress row not found'; end if;
end;
$$;

create or replace function public.record_chestny_catalog_search_page(
  p_launch uuid, p_manufacturer text, p_run uuid, p_expected_offset integer, p_next_offset integer,
  p_scanned integer, p_candidates jsonb, p_exhausted boolean
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.chestny_catalog_brand_search_progress;
  inserted integer := 0;
  r record;
  launch_status text;
  run_status text;
begin
  if p_expected_offset < 0 or p_next_offset <= p_expected_offset or p_scanned < 0
    or jsonb_typeof(coalesce(p_candidates, '[]'::jsonb)) <> 'array' then
    raise exception 'Invalid search page checkpoint';
  end if;
  select status into launch_status from public.chestny_catalog_launches where id = p_launch;
  if launch_status not in ('prepared', 'running') then raise exception 'Catalog launch is not searchable'; end if;
  select status into run_status from public.chestny_enrichment_runs where id = p_run;
  if run_status not in ('approved', 'running') then raise exception 'Enrichment run is not accepting candidates'; end if;
  if not exists (select 1 from public.chestny_catalog_launch_quotas
    where launch_id = p_launch and manufacturer = p_manufacturer) then
    raise exception 'Manufacturer has no diversity guidance entry';
  end if;
  insert into public.chestny_catalog_brand_search_progress(launch_id, manufacturer, run_id)
    values (p_launch, p_manufacturer, p_run) on conflict (launch_id, manufacturer) do nothing;
  select * into s from public.chestny_catalog_brand_search_progress
    where launch_id = p_launch and manufacturer = p_manufacturer for update;
  if s.run_id is not null and s.run_id <> p_run then
    if exists (select 1 from public.chestny_enrichment_runs old_run where old_run.id = s.run_id and old_run.status in ('approved', 'running'))
      or exists (select 1 from public.chestny_enrichment_queue old_queue where old_queue.run_id = s.run_id and old_queue.status in ('queued', 'leased')) then
      raise exception 'Previous brand search run is still active';
    end if;
    update public.chestny_catalog_brand_search_progress set run_id = p_run
      where launch_id = p_launch and manufacturer = p_manufacturer;
  end if;
  if p_expected_offset <> s.search_offset then
    if s.search_offset >= p_next_offset then return 0; end if;
    raise exception 'Search offset changed: expected %, current %', p_expected_offset, s.search_offset;
  end if;

  for r in
    select distinct on (x.source_listing_id) x.source_listing_id, x.source_url, x.candidate_snapshot
    from jsonb_to_recordset(coalesce(p_candidates, '[]'::jsonb)) as x(source_listing_id text, source_url text, candidate_snapshot jsonb)
    where coalesce(x.source_listing_id, '') <> ''
      and not exists (select 1 from public.chestny_catalog_launch_baseline_identifiers b where b.launch_id = p_launch and b.source_identifier = x.source_listing_id)
      and not exists (select 1 from public.vehicles v where v.source_listing_id = x.source_listing_id)
      and not exists (select 1 from public.vehicle_source_identifiers i where i.source_identifier = x.source_listing_id)
      and not exists (select 1 from public.encar_raw_listings e where e.source_listing_id = x.source_listing_id)
      and not exists (select 1 from public.chestny_catalog_staging st where st.source_listing_id = x.source_listing_id)
      and not exists (select 1 from public.chestny_enrichment_queue q where q.source_listing_id = x.source_listing_id)
    order by x.source_listing_id
  loop
    insert into public.chestny_enrichment_queue(run_id, source_listing_id, source_url, candidate_snapshot, status)
      values (p_run, r.source_listing_id, r.source_url, r.candidate_snapshot, 'queued')
      on conflict (run_id, source_listing_id) do nothing;
    if found then inserted := inserted + 1; end if;
  end loop;

  update public.chestny_catalog_brand_search_progress
    set run_id = p_run, search_offset = p_next_offset, scanned_count = scanned_count + p_scanned,
      candidate_count = candidate_count + inserted,
      status = case when p_exhausted then 'exhausted' else 'ready' end,
      last_page_at = now(), last_error = null, updated_at = now()
    where launch_id = p_launch and manufacturer = p_manufacturer;
  update public.chestny_enrichment_runs
    set candidate_count = (select count(*) from public.chestny_enrichment_queue where run_id = p_run)
    where id = p_run;
  return inserted;
end;
$$;

-- Keep each saved wave proportional to the brand-mix guidance. This is only
-- an ordering strategy: all queued candidates are still assigned and none are
-- dropped when a suggested brand count is reached.
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
  if p_safe_wave_capacity is null or p_safe_wave_capacity < 1 or p_safe_wave_capacity > 500 then
    raise exception 'Wave capacity must be 1..500';
  end if;
  if jsonb_typeof(coalesce(p_plan, '{}'::jsonb)) <> 'object' then
    raise exception 'Wave plan metadata must be a JSON object';
  end if;
  select r.status into v_status from public.chestny_enrichment_runs r where r.id = p_run_id for update;
  if not found then raise exception 'Enrichment run not found'; end if;
  if v_status <> 'approved' then raise exception 'Wave plan can only be created for an approved, not-yet-started run'; end if;
  perform q.id from public.chestny_enrichment_queue q where q.run_id = p_run_id order by q.id for update;
  if exists (select 1 from public.chestny_enrichment_waves w where w.run_id = p_run_id)
    or exists (select 1 from public.chestny_enrichment_queue q where q.run_id = p_run_id and q.wave_id is not null) then
    raise exception 'Wave plan already exists for this run';
  end if;
  if exists (select 1 from public.chestny_enrichment_queue q where q.run_id = p_run_id and q.status <> 'queued') then
    raise exception 'All candidates must still be queued before planning waves';
  end if;
  select count(*)::integer into v_total from public.chestny_enrichment_queue q where q.run_id = p_run_id;
  if v_total = 0 then raise exception 'Cannot plan waves for an empty queue'; end if;
  v_wave_count := ceil(v_total::numeric / p_safe_wave_capacity)::integer;
  v_base := v_total / v_wave_count;
  v_extra := v_total % v_wave_count;
  for v_index in 1..v_wave_count loop
    insert into public.chestny_enrichment_waves(run_id, wave_number, candidate_count, plan)
    values (p_run_id, v_index, v_base + case when v_index <= v_extra then 1 else 0 end,
      coalesce(p_plan, '{}'::jsonb) || jsonb_build_object(
        'totalCandidates', v_total, 'waveCount', v_wave_count, 'safeWaveCapacity', p_safe_wave_capacity,
        'distribution', 'balanced_by_candidate_count_and_brand_guidance')) returning id into v_wave_id;
    v_created := v_created + 1;
  end loop;
  with run_meta as (
    select nullif(r.rules->>'catalogLaunchId', '')::uuid as launch_id
    from public.chestny_enrichment_runs r where r.id = p_run_id
  ), per_brand as (
    select q.id, q.created_at, q.source_listing_id,
      coalesce(nullif(q.candidate_snapshot->>'quotaManufacturer', ''),
        nullif(q.candidate_snapshot->>'manufacturer', ''), '') as manufacturer,
      row_number() over (partition by coalesce(nullif(q.candidate_snapshot->>'quotaManufacturer', ''),
        nullif(q.candidate_snapshot->>'manufacturer', ''), '') order by q.created_at, q.source_listing_id) as brand_position,
      greatest(coalesce(b.target, 1), 1) as brand_weight
    from public.chestny_enrichment_queue q
    cross join run_meta m
    left join public.chestny_catalog_launch_quotas b
      on b.launch_id = m.launch_id and b.manufacturer = coalesce(nullif(q.candidate_snapshot->>'quotaManufacturer', ''),
        nullif(q.candidate_snapshot->>'manufacturer', ''), '')
    where q.run_id = p_run_id
  ), numbered as (
    select p.id,
      row_number() over (order by p.brand_position::numeric / p.brand_weight,
        p.created_at, p.manufacturer, p.source_listing_id)::integer as run_position
    from per_brand p
  ), assigned as (
    select n.id,
      floor(((n.run_position - 1)::numeric * v_wave_count) / v_total)::integer + 1 as wave_number,
      row_number() over (
        partition by floor(((n.run_position - 1)::numeric * v_wave_count) / v_total)::integer + 1
        order by n.run_position
      )::integer as wave_position
    from numbered n
  )
  update public.chestny_enrichment_queue q set wave_id = w.id, wave_position = a.wave_position, updated_at = now()
  from assigned a join public.chestny_enrichment_waves w on w.run_id = p_run_id and w.wave_number = a.wave_number
  where q.id = a.id;
  select jsonb_build_object('runId', p_run_id, 'candidateCount', v_total, 'waveCount', v_created,
    'distribution', 'balanced_by_candidate_count_and_brand_guidance',
    'waves', coalesce(jsonb_agg(jsonb_build_object('waveId', w.id, 'waveNumber', w.wave_number,
      'candidateCount', w.candidate_count) order by w.wave_number), '[]'::jsonb)) into v_summary
  from public.chestny_enrichment_waves w where w.run_id = p_run_id;
  return v_summary;
end;
$$;

revoke all on function public.plan_chestny_enrichment_waves(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.plan_chestny_enrichment_waves(uuid, integer, jsonb) to service_role;

-- The launch goal tracks actual counts; it has no publication-count ceiling.
create or replace function public.create_chestny_catalog_goal(p_launch uuid, p_origin_update_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  launch_row public.chestny_catalog_launches;
  task_row public.control_center_tasks;
begin
  if p_launch is null or p_origin_update_id is null then raise exception 'catalog launch and Telegram update id are required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_launch::text, 0));
  select t.* into task_row from public.control_center_goal_requests r
    join public.control_center_tasks t on t.id = r.task_id where r.telegram_update_id = p_origin_update_id;
  if task_row.id is not null then return jsonb_build_object('created', false, 'task', to_jsonb(task_row)); end if;
  select * into launch_row from public.chestny_catalog_launches where id = p_launch for share;
  if launch_row.id is null then raise exception 'catalog launch was not found'; end if;
  if launch_row.status not in ('prepared', 'running') then raise exception 'catalog launch is not ready'; end if;
  select * into task_row from public.control_center_tasks
    where module_id = 'chestny-prigon.catalog' and parameters->>'launchId' = p_launch::text
      and state in ('queued', 'preparing', 'ready', 'running')
    order by updated_at desc limit 1;
  if task_row.id is not null then
    insert into public.control_center_goal_requests(telegram_update_id, task_id)
      values (p_origin_update_id, task_row.id) on conflict (telegram_update_id) do nothing;
    return jsonb_build_object('created', false, 'task', to_jsonb(task_row));
  end if;
  insert into public.control_center_tasks(module_id, product, source, goal, parameters, state, progress, result, external_ref, origin_update_id)
    values ('chestny-prigon.catalog', 'chestny-prigon', 'encar',
      'Найти, обработать и опубликовать все новые объявления, прошедшие правила проекта; квоты марок — ориентир разнообразия',
      jsonb_build_object('launchId', p_launch, 'targetPublications', null, 'pilotTarget', null,
        'pilotApproved', false, 'publishAuthorized', false, 'maxItemsPerWave', 500),
      'queued', jsonb_build_object('stage', 'search_pending', 'intent', 'initial_search', 'waveNumber', 0, 'publicationEnabled', false),
      null, null, p_origin_update_id)
    returning * into task_row;
  insert into public.control_center_goal_requests(telegram_update_id, task_id) values (p_origin_update_id, task_row.id);
  return jsonb_build_object('created', true, 'task', to_jsonb(task_row));
end;
$$;

notify pgrst, 'reload schema';
commit;
