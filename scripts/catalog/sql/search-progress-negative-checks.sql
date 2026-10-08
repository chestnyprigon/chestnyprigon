do $$
declare l uuid; r uuid; source_id text; page jsonb; inserted integer; offset_value integer; candidate_count_value integer; search_status text;
begin
  source_id := 'step4-test-'||extensions.gen_random_uuid()::text;
  insert into public.chestny_catalog_launches(name,rules,baseline_counts,status)
    values('step4-search-test-'||extensions.gen_random_uuid()::text,'{}','{}','prepared') returning id into l;
  insert into public.chestny_catalog_launch_quotas(launch_id,manufacturer,target,baseline_public_count) values(l,'BMW',1,0);
  insert into public.chestny_catalog_brand_search_progress(launch_id,manufacturer) values(l,'BMW');
  insert into public.chestny_enrichment_runs(project,status,candidate_count,source_file,rules)
    values('chestny-prigon','approved',0,'step4-search-test',jsonb_build_object('catalogLaunchId',l)) returning id into r;
  perform public.start_chestny_catalog_brand_search(l,'BMW',r);
  if (select status from public.chestny_catalog_brand_search_progress where launch_id=l and manufacturer='BMW')<>'searching' then raise exception 'TEST FAILED: searching state not persisted'; end if;
  page := jsonb_build_array(jsonb_build_object('source_listing_id',source_id,'source_url','https://www.encar.com/dc/dc_cardetailview.do?carid='||source_id,'candidate_snapshot',jsonb_build_object('encarId',source_id,'quotaManufacturer','BMW')));
  inserted := public.record_chestny_catalog_search_page(l,'BMW',r,0,100,50,page,false);
  if inserted<>1 then raise exception 'TEST FAILED: first page candidate was not queued'; end if;
  inserted := public.record_chestny_catalog_search_page(l,'BMW',r,0,100,50,page,false);
  if inserted<>0 then raise exception 'TEST FAILED: replayed page inserted a duplicate'; end if;
  select search_offset,candidate_count,status into offset_value,candidate_count_value,search_status
    from public.chestny_catalog_brand_search_progress where launch_id=l and manufacturer='BMW';
  if offset_value<>100 or candidate_count_value<>1 or search_status<>'ready' then raise exception 'TEST FAILED: page checkpoint not persisted'; end if;
  inserted := public.record_chestny_catalog_search_page(l,'BMW',r,100,200,0,'[]',true);
  select search_offset,status into offset_value,search_status from public.chestny_catalog_brand_search_progress where launch_id=l and manufacturer='BMW';
  if offset_value<>200 or search_status<>'exhausted' then raise exception 'TEST FAILED: exhausted state not persisted'; end if;
  if exists(select 1 from public.chestny_enrichment_queue where run_id=r and source_listing_id=source_id having count(*)<>1) then raise exception 'TEST FAILED: candidate duplicated'; end if;
  perform public.record_chestny_catalog_search_error(l,'BMW','simulated HTTP 429');
  select search_offset,status into offset_value,search_status from public.chestny_catalog_brand_search_progress where launch_id=l and manufacturer='BMW';
  if offset_value<>200 or search_status<>'paused' then raise exception 'TEST FAILED: error did not pause without changing offset'; end if;
end; $$;
select 'per-brand offset resume, idempotent page replay, exhausted status and error pause passed' as checkpoint;
