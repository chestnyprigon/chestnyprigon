begin;

alter table public.mobile_de_catalog_listings
  add column if not exists pricing_mode text not null default 'calculated';

alter table public.mobile_de_catalog_listings
  drop constraint if exists mobile_de_catalog_listings_pricing_mode_check,
  add constraint mobile_de_catalog_listings_pricing_mode_check
    check (pricing_mode in ('calculated', 'manager_consultation'));

alter table public.mobile_de_catalog_listings
  drop constraint if exists mobile_de_catalog_listings_customer_cohort_check,
  add constraint mobile_de_catalog_listings_customer_cohort_check
    check (customer_cohort in ('legacy_proven', 'customer_europe_2026', 'mobile_de_fresh_2026'));

alter table public.mobile_de_catalog_listings
  drop constraint if exists mobile_de_catalog_visibility_requires_approved_data,
  add constraint mobile_de_catalog_visibility_requires_approved_data check (
    not catalog_visible or (
      price_currency = 'EUR'
      and price_amount > 0
      and primary_image_url is not null
      and not is_new_vehicle
      and (
        (
          customer_cohort = 'mobile_de_fresh_2026'
          and first_registration_precision in ('year', 'month', 'day')
          and registration_year between 2022 and 2025
          and source_status in ('active', 'unknown')
          and proof_status = 'customer_selected'
          and (
            (
              transport_class = 'CAR' and pricing_mode = 'calculated' and mileage_km <= 100000
              and (
                (source_payload->>'collection_strategy' = 'STRATEGY_1_EU_4BRANDS'
                  and upper(make) in ('AUDI','VW','VOLKSWAGEN','BMW','MERCEDES','MERCEDES-BENZ')
                  and power_ps <= 160
                  and price_category_eligible
                  and (price_category is null or price_category in ('Sehr guter Preis', 'Guter Preis', 'Fairer Preis')))
                or model_group in ('Renault Megane','Peugeot 308','Peugeot 3008','Citroen Spacetourer','Citroen Grand C4 Spacetourer','SEAT Ateca','Opel Insignia')
              )
            )
            or
            (
              transport_class = 'VAN' and pricing_mode = 'manager_consultation'
              and mileage_km <= 150000 and fuel_type = 'DIESEL'
              and model_group in ('Mercedes-Benz Sprinter','Volkswagen Crafter','MAN TGE','Fiat Ducato')
            )
          )
        )
        or
        (
          customer_cohort = 'customer_europe_2026'
          and first_registration_precision in ('year', 'month', 'day')
          and registration_year between 2022 and 2023
          and source_status in ('active', 'unknown')
          and proof_status = 'customer_selected'
          and (
            (transport_class = 'CAR' and mileage_km <= 100000)
            or (transport_class = 'VAN' and mileage_km <= 150000 and fuel_type = 'DIESEL')
          )
        )
        or
        (
          customer_cohort = 'legacy_proven'
          and first_registration_precision in ('month', 'day')
          and source_status = 'active'
          and proof_status = 'proven_verified'
          and registration_year between 2022 and 2025
          and power_ps <= 160
          and mileage_km <= 100000
          and price_category_eligible
          and (price_category is null or price_category in ('Sehr guter Preis', 'Guter Preis', 'Fairer Preis'))
        )
      )
    )
  );

create or replace view public.mobile_de_catalog_public_listings
with (security_barrier = true)
as
select master_id, source_id, title, make, model, production_year, first_registration,
       first_registration_precision, registration_year, mileage_km, engine_cc, power_ps,
       price_amount, price_currency, price_category, fuel_type, transmission, drive, body_type,
       color, description, options, source_url, primary_image_url, source_updated_at,
       last_seen_at, verified_at, updated_at, transport_class, customer_cohort, model_group,
       source_gross_amount, reported_net_amount, price_basis, pricing_mode
from public.mobile_de_catalog_listings
where catalog_visible;

create or replace function public.queue_russia_price_snapshot()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  listing_source text;
  listing_id_value text;
  is_eligible boolean;
begin
  if tg_table_name = 'vehicles' then
    listing_source := 'korea';
    listing_id_value := new.id::text;
    is_eligible := new.status = 'active' and new.is_public;
  else
    listing_source := 'europe';
    listing_id_value := new.master_id::text;
    is_eligible := new.source_status = 'active'
      and new.catalog_visible
      and new.pricing_mode = 'calculated'
      and (
        new.customer_cohort <> 'mobile_de_fresh_2026' or new.engine_cc is not null
      )
      and (
        new.proof_status = 'proven_verified'
        or (new.proof_status = 'customer_selected' and new.customer_cohort in ('customer_europe_2026', 'mobile_de_fresh_2026'))
      );
  end if;

  if not is_eligible then
    delete from public.russia_price_snapshots
    where source = listing_source and listing_id = listing_id_value and destination = 'RU';
    return new;
  end if;

  insert into public.russia_price_snapshots (source, listing_id, destination, status, next_refresh_at)
  values (listing_source, listing_id_value, 'RU', 'pending', now())
  on conflict (source, listing_id, destination) do update
    set status = 'pending',
        revision = public.russia_price_snapshots.revision + 1,
        next_refresh_at = now(),
        last_error_code = null,
        updated_at = now();
  return new;
end;
$$;

revoke all on function public.queue_russia_price_snapshot() from public, anon, authenticated;

commit;
