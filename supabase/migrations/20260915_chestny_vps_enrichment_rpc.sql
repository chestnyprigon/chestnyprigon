create or replace function public.claim_chestny_enrichment_queue(p_run_id uuid, p_limit integer, p_lease_minutes integer)
returns setof public.chestny_enrichment_queue
language sql security definer set search_path = public
as $$
  with picked as (
    select id from public.chestny_enrichment_queue
    where run_id = p_run_id and status = 'queued'
    order by created_at
    for update skip locked limit greatest(1, least(p_limit, 50))
  )
  update public.chestny_enrichment_queue q
  set status='leased', lease_until=now()+make_interval(mins=>greatest(5,least(p_lease_minutes,120))),
      last_attempt_at=now(), attempt_count=q.attempt_count+1, updated_at=now()
  from picked where q.id=picked.id returning q.*;
$$;

create or replace function public.complete_chestny_enrichment_queue_item(
  p_queue_id uuid, p_status text, p_result jsonb, p_payload jsonb default null,
  p_fuel text default null, p_color text default null, p_image_urls jsonb default '[]'::jsonb, p_error text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_source_id text; v_source_url text;
begin
  if p_status not in ('succeeded','unavailable','failed') then raise exception 'unsupported status %',p_status; end if;
  select source_listing_id,source_url into v_source_id,v_source_url from public.chestny_enrichment_queue where id=p_queue_id for update;
  if v_source_id is null then raise exception 'queue item not found'; end if;
  if p_status='succeeded' then
    insert into public.chestny_catalog_staging(source_listing_id,source_url,candidate_snapshot,encar_payload,image_urls,fuel_type,exterior_color,report_status,enrichment_status,updated_at)
    select v_source_id,v_source_url,candidate_snapshot,p_payload,coalesce(p_image_urls,'[]'::jsonb),p_fuel,p_color,
      case when (p_result->>'inspectionAvailable')::boolean then 'ready' else 'unavailable' end,'succeeded',now()
    from public.chestny_enrichment_queue where id=p_queue_id
    on conflict (source_listing_id) do update set encar_payload=excluded.encar_payload,image_urls=excluded.image_urls,
      fuel_type=coalesce(excluded.fuel_type,chestny_catalog_staging.fuel_type),exterior_color=coalesce(excluded.exterior_color,chestny_catalog_staging.exterior_color),
      report_status=excluded.report_status,enrichment_status='succeeded',updated_at=now();
  elsif p_status='unavailable' then
    insert into public.chestny_catalog_staging(source_listing_id,source_url,enrichment_status,updated_at)
    values(v_source_id,v_source_url,'unavailable',now()) on conflict(source_listing_id) do update set enrichment_status='unavailable',updated_at=now();
  end if;
  update public.chestny_enrichment_queue set status=p_status,result=p_result,lease_until=null,
    completed_at=case when p_status in ('succeeded','unavailable') then now() else null end,
    last_error=case when p_status='failed' then p_error else null end,updated_at=now() where id=p_queue_id;
end; $$;

grant execute on function public.claim_chestny_enrichment_queue(uuid,integer,integer) to service_role;
grant execute on function public.complete_chestny_enrichment_queue_item(uuid,text,jsonb,jsonb,text,text,jsonb,text) to service_role;
