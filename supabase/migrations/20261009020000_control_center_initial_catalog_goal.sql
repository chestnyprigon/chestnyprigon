alter table public.control_center_tasks
  add column if not exists origin_update_id bigint unique;

create table if not exists public.control_center_goal_requests (
  telegram_update_id bigint primary key,
  task_id uuid not null references public.control_center_tasks(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.control_center_goal_requests enable row level security;
revoke all on public.control_center_goal_requests from anon, authenticated;
grant select, insert on public.control_center_goal_requests to service_role;

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
  if p_launch is null or p_origin_update_id is null then
    raise exception 'catalog launch and Telegram update id are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_launch::text, 0));

  select t.* into task_row
  from public.control_center_goal_requests r
  join public.control_center_tasks t on t.id = r.task_id
  where r.telegram_update_id = p_origin_update_id;
  if task_row.id is not null then
    return jsonb_build_object('created', false, 'task', to_jsonb(task_row));
  end if;

  select * into launch_row from public.chestny_catalog_launches where id = p_launch for share;
  if launch_row.id is null then raise exception 'catalog launch was not found'; end if;
  if launch_row.name <> 'local-catalog-1000-20261007' then raise exception 'catalog launch is not the configured pilot plan'; end if;
  if launch_row.status not in ('prepared', 'running') then raise exception 'catalog launch is not ready'; end if;

  select * into task_row
  from public.control_center_tasks
  where module_id = 'chestny-prigon.catalog'
    and parameters->>'launchId' = p_launch::text
    and state in ('queued', 'preparing', 'ready', 'running')
  order by updated_at desc
  limit 1;
  if task_row.id is not null then
    insert into public.control_center_goal_requests(telegram_update_id, task_id)
      values(p_origin_update_id, task_row.id) on conflict(telegram_update_id) do nothing;
    return jsonb_build_object('created', false, 'task', to_jsonb(task_row));
  end if;

  insert into public.control_center_tasks(
    module_id, product, source, goal, parameters, state, progress, result, external_ref, origin_update_id
  ) values (
    'chestny-prigon.catalog', 'chestny-prigon', 'encar',
    'Найти и обработать пилотную волну до 50 новых автомобилей по утверждённым квотам',
    jsonb_build_object('launchId', p_launch, 'targetPublications', 1000, 'pilotTarget', 50,
      'pilotApproved', false, 'publishAuthorized', false, 'maxItemsPerWave', 50),
    'queued', jsonb_build_object('stage', 'search_pending', 'intent', 'initial_search', 'waveNumber', 0,
      'publicationEnabled', false), null, null, p_origin_update_id
  ) returning * into task_row;

  insert into public.control_center_goal_requests(telegram_update_id, task_id)
    values(p_origin_update_id, task_row.id);

  return jsonb_build_object('created', true, 'task', to_jsonb(task_row));
end;
$$;

revoke all on function public.create_chestny_catalog_goal(uuid, bigint) from public, anon, authenticated;
grant execute on function public.create_chestny_catalog_goal(uuid, bigint) to service_role;

create or replace function public.record_chestny_catalog_search_page(
  p_launch uuid,p_manufacturer text,p_run uuid,p_expected_offset integer,p_next_offset integer,
  p_scanned integer,p_candidates jsonb,p_exhausted boolean
) returns integer language plpgsql security definer set search_path='' as $$
declare s public.chestny_catalog_brand_search_progress; inserted integer:=0; r record; launch_status text; run_status text; quota_remaining integer;
begin
  if p_expected_offset<0 or p_next_offset<=p_expected_offset or p_scanned<0 or jsonb_typeof(coalesce(p_candidates,'[]'::jsonb))<>'array' then
    raise exception 'Invalid search page checkpoint';
  end if;
  select status into launch_status from public.chestny_catalog_launches where id=p_launch;
  if launch_status not in ('prepared','running') then raise exception 'Catalog launch is not searchable'; end if;
  select status into run_status from public.chestny_enrichment_runs where id=p_run;
  if run_status not in ('approved','running') then raise exception 'Enrichment run is not accepting candidates'; end if;
  select remaining into quota_remaining from public.chestny_catalog_launch_progress where launch_id=p_launch and manufacturer=p_manufacturer;
  if quota_remaining is null then raise exception 'Manufacturer has no quota'; end if;
  insert into public.chestny_catalog_brand_search_progress(launch_id,manufacturer,run_id)
    values(p_launch,p_manufacturer,p_run) on conflict(launch_id,manufacturer) do nothing;
  select * into s from public.chestny_catalog_brand_search_progress where launch_id=p_launch and manufacturer=p_manufacturer for update;
  if s.run_id is not null and s.run_id<>p_run then
    if exists(select 1 from public.chestny_enrichment_runs old_run where old_run.id=s.run_id and old_run.status in ('approved','running'))
      or (exists(select 1 from public.chestny_enrichment_queue old_queue where old_queue.run_id=s.run_id and old_queue.status in ('queued','leased'))
        and not exists(select 1 from public.chestny_enrichment_runs old_run where old_run.id=s.run_id and old_run.status='paused')) then
      raise exception 'Previous brand search run is still active';
    end if;
    update public.chestny_catalog_brand_search_progress set run_id=p_run where launch_id=p_launch and manufacturer=p_manufacturer;
  end if;
  if p_expected_offset<>s.search_offset then
    if s.search_offset>=p_next_offset then return 0; end if;
    raise exception 'Search offset changed: expected %, current %',p_expected_offset,s.search_offset;
  end if;
  if quota_remaining=0 then raise exception 'Brand quota is already filled'; end if;
  for r in
    select distinct on (x.source_listing_id) x.source_listing_id,x.source_url,x.candidate_snapshot
    from jsonb_to_recordset(coalesce(p_candidates,'[]'::jsonb)) as x(source_listing_id text,source_url text,candidate_snapshot jsonb)
    where coalesce(x.source_listing_id,'')<>''
      and not exists(select 1 from public.chestny_catalog_launch_baseline_identifiers b where b.launch_id=p_launch and b.source_identifier=x.source_listing_id)
      and not exists(select 1 from public.vehicles v where v.source_listing_id=x.source_listing_id)
      and not exists(select 1 from public.vehicle_source_identifiers i where i.source_identifier=x.source_listing_id)
      and not exists(select 1 from public.encar_raw_listings e where e.source_listing_id=x.source_listing_id)
      and not exists(select 1 from public.chestny_catalog_staging st where st.source_listing_id=x.source_listing_id)
      and not exists(select 1 from public.chestny_enrichment_queue q where q.source_listing_id=x.source_listing_id)
    order by x.source_listing_id
  loop
    insert into public.chestny_enrichment_queue(run_id,source_listing_id,source_url,candidate_snapshot,status)
      values(p_run,r.source_listing_id,r.source_url,r.candidate_snapshot,'queued') on conflict(run_id,source_listing_id) do nothing;
    if found then inserted:=inserted+1; end if;
  end loop;
  update public.chestny_catalog_brand_search_progress set run_id=p_run,search_offset=p_next_offset,
    scanned_count=scanned_count+p_scanned,candidate_count=candidate_count+inserted,
    status=case when p_exhausted then 'exhausted' else 'ready' end,last_page_at=now(),last_error=null,updated_at=now()
    where launch_id=p_launch and manufacturer=p_manufacturer;
  update public.chestny_enrichment_runs set candidate_count=(select count(*) from public.chestny_enrichment_queue where run_id=p_run) where id=p_run;
  return inserted;
end; $$;

revoke all on function public.record_chestny_catalog_search_page(uuid,text,uuid,integer,integer,integer,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.record_chestny_catalog_search_page(uuid,text,uuid,integer,integer,integer,jsonb,boolean) to service_role;
