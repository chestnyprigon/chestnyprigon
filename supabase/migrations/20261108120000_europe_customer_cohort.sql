alter table public.mobile_de_catalog_listings
  add column if not exists transport_class text not null default 'CAR',
  add column if not exists customer_cohort text not null default 'legacy_proven',
  add column if not exists model_group text,
  add column if not exists source_gross_amount numeric(14,2),
  add column if not exists reported_net_amount numeric(14,2),
  add column if not exists price_basis text not null default 'unknown',
  add column if not exists price_provenance jsonb not null default '{}'::jsonb;

alter table public.mobile_de_catalog_listings
  alter column price_category drop not null,
  alter column power_ps drop not null;

alter table public.mobile_de_catalog_listings
  drop constraint if exists mobile_de_catalog_listings_transport_class_check,
  add constraint mobile_de_catalog_listings_transport_class_check
    check (transport_class in ('CAR', 'VAN')),
  drop constraint if exists mobile_de_catalog_listings_customer_cohort_check,
  add constraint mobile_de_catalog_listings_customer_cohort_check
    check (customer_cohort in ('legacy_proven', 'customer_europe_2026')),
  drop constraint if exists mobile_de_catalog_listings_price_basis_check,
  add constraint mobile_de_catalog_listings_price_basis_check
    check (price_basis in ('netto', 'brutto', 'unknown')),
  drop constraint if exists mobile_de_catalog_price_basis_consistent,
  add constraint mobile_de_catalog_price_basis_consistent check (
    (price_basis = 'unknown')
    or (price_basis = 'netto' and reported_net_amount > 0 and price_amount = reported_net_amount)
    or (price_basis = 'brutto' and source_gross_amount > 0 and price_amount = source_gross_amount)
  ),
  drop constraint if exists mobile_de_catalog_listings_price_provenance_check,
  add constraint mobile_de_catalog_listings_price_provenance_check
    check (jsonb_typeof(price_provenance) = 'object');

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

create index if not exists mobile_de_visible_transport_cohort_idx
  on public.mobile_de_catalog_listings (customer_cohort, transport_class, make, model, master_id)
  where catalog_visible;

create or replace view public.mobile_de_catalog_public_listings
with (security_barrier = true)
as
select master_id, source_id, title, make, model, production_year, first_registration,
       first_registration_precision, registration_year, mileage_km, engine_cc, power_ps,
       price_amount, price_currency, price_category, fuel_type, transmission, drive, body_type,
       color, description, options, source_url, primary_image_url, source_updated_at,
       last_seen_at, verified_at, updated_at, transport_class, customer_cohort, model_group,
       source_gross_amount, reported_net_amount, price_basis
from public.mobile_de_catalog_listings
where catalog_visible;

comment on column public.mobile_de_catalog_listings.customer_cohort is
  'Separates customer-selected 2026 Europe listings from the existing proven catalog policy.';
comment on column public.mobile_de_catalog_listings.price_basis is
  'Source price basis used for display and preliminary estimate: source-reported Netto, otherwise source Brutto.';
