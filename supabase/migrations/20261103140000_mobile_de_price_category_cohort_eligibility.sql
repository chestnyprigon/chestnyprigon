alter table public.mobile_de_catalog_listings
  alter column price_category drop not null;

alter table public.mobile_de_catalog_listings
  add column if not exists price_category_eligible boolean not null default false;

alter table public.mobile_de_catalog_listings
  drop constraint if exists mobile_de_catalog_visibility_requires_approved_data;

alter table public.mobile_de_catalog_listings
  drop constraint if exists mobile_de_catalog_listings_price_category_check;

alter table public.mobile_de_catalog_listings
  add constraint mobile_de_catalog_listings_price_category_check
  check (price_category is null or price_category in ('Sehr guter Preis', 'Guter Preis', 'Fairer Preis'));

alter table public.mobile_de_catalog_listings
  add constraint mobile_de_catalog_visibility_requires_approved_data check (
    not catalog_visible or (
      source_status = 'active'
      and proof_status = 'proven_verified'
      and first_registration_precision in ('month', 'day')
      and registration_year between 2022 and 2025
      and power_ps <= 160
      and mileage_km <= 100000
      and price_category_eligible
      and (price_category is null or price_category in ('Sehr guter Preis', 'Guter Preis', 'Fairer Preis'))
      and not is_new_vehicle
    )
  );

comment on column public.mobile_de_catalog_listings.price_category is
  'Exact Mobile.de price label when present in the source API; null when only filtered-cohort eligibility is available.';
comment on column public.mobile_de_catalog_listings.price_category_eligible is
  'True only when the exact low/mid rating is present or the row comes from the upstream filtered candidate cohort.';
