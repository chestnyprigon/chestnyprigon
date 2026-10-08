do $$
declare l uuid; v public.vehicles; first_id uuid; next_id uuid; first_source text; next_source text; proof jsonb; used integer;
begin
  select * into v from public.vehicles where source_listing_id='41544328';
  insert into public.chestny_catalog_launches(name,rules,baseline_counts,status) values('rollback-test-'||extensions.gen_random_uuid(), '{}','{}','prepared') returning id into l;
  insert into public.chestny_catalog_launch_quotas values(l,'BMW',1,0);
  first_source='rollback-first-'||l; next_source='rollback-next-'||l;
  insert into public.encar_raw_listings(source_listing_id,payload,payload_hash) values(first_source,'{}','test'),(next_source,'{}','test');
  insert into public.vehicles(source_listing_id,manufacturer,model,model_year,mileage_km,price_krw,price_usd,engine_cc,fuel_type,transmission,source_url,source_updated_at,catalog_launch_id)
    values(first_source,v.manufacturer,v.model,v.model_year,v.mileage_km,v.price_krw,v.price_usd,v.engine_cc,v.fuel_type,v.transmission,v.source_url,now(),l) returning id into first_id;
  insert into public.vehicles(source_listing_id,manufacturer,model,model_year,mileage_km,price_krw,price_usd,engine_cc,fuel_type,transmission,source_url,source_updated_at,catalog_launch_id)
    values(next_source,v.manufacturer,v.model,v.model_year,v.mileage_km,v.price_krw,v.price_usd,v.engine_cc,v.fuel_type,v.transmission,v.source_url,now(),l) returning id into next_id;
  proof=jsonb_build_object('validated',true,'normalized',jsonb_build_object('manufacturer',v.manufacturer,'model',v.model,'modelYear',v.model_year,'mileageKm',v.mileage_km,'engineCc',v.engine_cc,'fuelType',v.fuel_type,'transmission',v.transmission,'priceKrw',v.price_krw));
  insert into public.listing_screening(source_listing_id,decision,rules_version,details) values
    (first_source,'approved','2026-10-07.1',jsonb_build_object('publicationGate',proof||jsonb_build_object('canonicalId',first_source))),
    (next_source,'approved','2026-10-07.1',jsonb_build_object('publicationGate',proof||jsonb_build_object('canonicalId',next_source)));
  insert into public.vehicle_images(vehicle_id,source_url,position) select first_id,'https://ci.encar.com/rollback-'||i||'.jpg',i from generate_series(0,4) i;
  insert into public.vehicle_images(vehicle_id,source_url,position) select next_id,'https://ci.encar.com/rollback-'||i||'.jpg',i from generate_series(0,4) i;
  insert into public.vehicle_reports(vehicle_id,canonical_vehicle_id,report_status) values(first_id,first_source,'unavailable'),(next_id,next_source,'unavailable');
  update public.vehicles set is_public=true where id=first_id;
  update public.vehicles set is_public=true where id=first_id;
  select credited_publications into used from public.chestny_catalog_launch_progress where launch_id=l;
  if used<>1 then raise exception 'TEST FAILED: repeated publication double-counted'; end if;
  begin
    update public.vehicles set is_public=true where id=next_id;
    raise exception 'TEST FAILED: quota exceeded';
  exception when others then if sqlerrm not like '%Brand quota reached%' then raise; end if; end;
  update public.vehicles set is_public=false where id=first_id;
  select published into used from public.chestny_catalog_launch_progress where launch_id=l;
  if used<>0 then raise exception 'TEST FAILED: hidden credit counted as public'; end if;
  update public.vehicles set is_public=true where id=first_id;
  insert into public.chestny_catalog_launch_baseline_identifiers values(l,next_source);
  begin
    update public.vehicles set is_public=true where id=next_id;
    raise exception 'TEST FAILED: baseline credited';
  exception when others then if sqlerrm not like '%Existing baseline listing%' then raise; end if; end;
end; $$;
select 'quota cap, publication idempotence, active credit count and baseline exclusion passed' as checkpoint;
