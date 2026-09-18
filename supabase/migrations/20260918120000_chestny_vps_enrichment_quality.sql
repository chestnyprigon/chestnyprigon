create or replace function public.complete_chestny_enrichment_queue_item(
  p_queue_id uuid, p_status text, p_result jsonb, p_payload jsonb default null,
  p_fuel text default null, p_color text default null, p_image_urls jsonb default '[]'::jsonb, p_error text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_source_id text; v_source_url text; v_snapshot jsonb;
begin
  if p_status not in ('succeeded','unavailable','failed') then raise exception 'unsupported status %',p_status; end if;
  select source_listing_id,source_url,candidate_snapshot into v_source_id,v_source_url,v_snapshot
  from public.chestny_enrichment_queue where id=p_queue_id for update;
  if v_source_id is null then raise exception 'queue item not found'; end if;
  if p_status='succeeded' then
    insert into public.chestny_catalog_staging(source_listing_id,source_url,candidate_snapshot,encar_payload,image_urls,fuel_type,exterior_color,report_status,enrichment_status,updated_at)
    values(v_source_id,v_source_url,coalesce(v_snapshot,'{}'::jsonb),p_payload,coalesce(p_image_urls,'[]'::jsonb),p_fuel,p_color,
      case when coalesce((p_result->>'reportReady')::boolean,false) then 'ready' else 'unavailable' end,'succeeded',now())
    on conflict (source_listing_id) do update set
      source_url=excluded.source_url,
      candidate_snapshot=excluded.candidate_snapshot,
      encar_payload=excluded.encar_payload,
      image_urls=excluded.image_urls,
      fuel_type=coalesce(excluded.fuel_type,chestny_catalog_staging.fuel_type),
      exterior_color=coalesce(excluded.exterior_color,chestny_catalog_staging.exterior_color),
      report_status=excluded.report_status,
      enrichment_status='succeeded',updated_at=now();
  elsif p_status='unavailable' then
    insert into public.chestny_catalog_staging(source_listing_id,source_url,candidate_snapshot,enrichment_status,updated_at)
    values(v_source_id,v_source_url,coalesce(v_snapshot,'{}'::jsonb),'unavailable',now())
    on conflict(source_listing_id) do update set candidate_snapshot=excluded.candidate_snapshot,enrichment_status='unavailable',updated_at=now();
  end if;
  update public.chestny_enrichment_queue set status=p_status,result=p_result,lease_until=null,
    completed_at=case when p_status in ('succeeded','unavailable') then now() else null end,
    last_error=case when p_status='failed' then p_error else null end,updated_at=now() where id=p_queue_id;
end; $$;

grant execute on function public.complete_chestny_enrichment_queue_item(uuid,text,jsonb,jsonb,text,text,jsonb,text) to service_role;
