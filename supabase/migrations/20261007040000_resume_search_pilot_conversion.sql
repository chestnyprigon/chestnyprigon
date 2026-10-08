begin;
alter table public.chestny_catalog_launches add column if not exists pilot_candidate_count integer not null default 0 check(pilot_candidate_count>=0);
alter table public.chestny_catalog_launches add column if not exists pilot_published_count integer not null default 0 check(pilot_published_count>=0 and pilot_published_count<=pilot_candidate_count);
alter table public.chestny_catalog_launches add column if not exists pilot_conversion_rate numeric(7,6) check(pilot_conversion_rate is null or pilot_conversion_rate between 0 and 1);

create or replace function public.start_chestny_catalog_brand_search(p_launch uuid,p_manufacturer text,p_run uuid) returns void
language plpgsql security definer set search_path='' as $$
declare remaining integer;
begin
  select g.remaining into remaining from public.chestny_catalog_launch_progress g
    where g.launch_id=p_launch and g.manufacturer=p_manufacturer;
  if remaining is null then raise exception 'Manufacturer has no quota'; end if;
  if remaining=0 then raise exception 'Brand quota is already filled'; end if;
  update public.chestny_catalog_brand_search_progress set run_id=p_run,status='searching',last_error=null,updated_at=now()
    where launch_id=p_launch and manufacturer=p_manufacturer;
  if not found then raise exception 'Brand search progress row not found'; end if;
end; $$;

revoke all on function public.start_chestny_catalog_brand_search(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.start_chestny_catalog_brand_search(uuid,text,uuid) to service_role;

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
      or exists(select 1 from public.chestny_enrichment_queue old_queue where old_queue.run_id=s.run_id and old_queue.status in ('queued','leased')) then
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

create or replace function public.record_chestny_catalog_search_error(p_launch uuid,p_manufacturer text,p_message text) returns void
language plpgsql security definer set search_path='' as $$
begin
  update public.chestny_catalog_brand_search_progress set status='paused',last_error=left(p_message,500),updated_at=now()
  where launch_id=p_launch and manufacturer=p_manufacturer;
  if not found then raise exception 'Brand search progress row not found'; end if;
end; $$;

revoke all on function public.record_chestny_catalog_search_error(uuid,text,text) from public,anon,authenticated;
grant execute on function public.record_chestny_catalog_search_error(uuid,text,text) to service_role;

drop view if exists public.chestny_catalog_brand_search_status;

create or replace view public.chestny_catalog_brand_search_status with (security_invoker=true) as
select p.launch_id,p.manufacturer,p.run_id,p.search_offset,p.scanned_count,p.candidate_count,p.processed_candidates,
  coalesce(p.conversion_rate,l.pilot_conversion_rate) as conversion_rate,p.conversion_rate as brand_conversion_rate,
  l.pilot_conversion_rate as overall_conversion_rate,p.pilot_candidates,p.pilot_publications,p.status,p.last_page_at,p.last_error,
  q.target,g.published as published_count,g.remaining as remaining_quota,
  greatest(0,p.candidate_count-p.processed_candidates)::integer as candidate_backlog,
  case when coalesce(p.conversion_rate,l.pilot_conversion_rate) is not null and coalesce(p.conversion_rate,l.pilot_conversion_rate)>0 then
    greatest(0,ceil(g.remaining::numeric/coalesce(p.conversion_rate,l.pilot_conversion_rate))-(p.candidate_count-p.processed_candidates))::integer
    else null end as candidates_needed_at_observed_conversion
from public.chestny_catalog_brand_search_progress p
join public.chestny_catalog_launch_quotas q using(launch_id,manufacturer)
join public.chestny_catalog_launch_progress g using(launch_id,manufacturer)
join public.chestny_catalog_launches l on l.id=p.launch_id;
grant select on public.chestny_catalog_brand_search_status to service_role;
revoke all on public.chestny_catalog_brand_search_status from anon,authenticated;


notify pgrst,'reload schema';
commit;
