begin;

-- Brand counts guide a diverse catalog mix; they do not make a screened
-- vehicle ineligible for publication. Keep launch, baseline, screening,
-- integrity, freshness, photo, and report guards in enforce_vehicle_publication.
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

  if s.source_listing_id is null
    or s.decision <> 'approved'
    or s.is_lease or s.is_rental or s.is_taxi or s.is_commercial or s.is_problematic then
    raise exception 'Listing % has not passed publication screening', new.source_listing_id;
  end if;

  v_new_publication := tg_op = 'INSERT';
  if tg_op = 'UPDATE' then
    v_new_publication := not old.is_public
      or old.source_listing_id <> new.source_listing_id
      or old.catalog_launch_id is distinct from new.catalog_launch_id;
    if old.catalog_launch_id is not null
      and (old.catalog_launch_id is distinct from new.catalog_launch_id or old.manufacturer <> new.manufacturer) then
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
      'manufacturer', new.manufacturer,
      'model', new.model,
      'modelYear', new.model_year,
      'mileageKm', new.mileage_km,
      'engineCc', new.engine_cc,
      'fuelType', new.fuel_type,
      'transmission', new.transmission,
      'priceKrw', new.price_krw
    ) then
      raise exception 'Normalized catalogue fields conflict with validated payload';
    end if;
    if (select count(*) from public.vehicle_images where vehicle_id = new.id) < 5 then
      raise exception 'Catalogue requires five photographs';
    end if;
    if not exists (
      select 1 from public.vehicle_reports
      where vehicle_id = new.id
        and canonical_vehicle_id = new.source_listing_id
        and report_status in ('ready', 'unavailable')
    ) then
      raise exception 'Report result is not confirmed';
    end if;
  end if;

  if new.catalog_launch_id is not null and v_new_publication then
    if not exists (
      select 1 from public.chestny_catalog_launches
      where id = new.catalog_launch_id and status in ('prepared', 'running')
    ) then
      raise exception 'Launch is not active';
    end if;
    if exists (
      select 1 from public.chestny_catalog_launch_baseline_identifiers
      where launch_id = new.catalog_launch_id and source_identifier = new.source_listing_id
    ) then
      raise exception 'Existing baseline listing cannot be counted as new';
    end if;
    if not exists (
      select 1 from public.chestny_catalog_launch_quotas
      where launch_id = new.catalog_launch_id and manufacturer = new.manufacturer
    ) then
      raise exception 'Brand is not included in the launch recommendations';
    end if;
  end if;

  new.published_at = coalesce(new.published_at, now());
  return new;
end;
$$;

commit;
