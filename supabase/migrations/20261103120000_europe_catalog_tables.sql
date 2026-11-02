create table if not exists public.mobile_de_catalog_listings (
  master_id uuid primary key,
  source_id text not null unique,
  title text not null,
  make text not null,
  model text,
  production_year smallint,
  first_registration text not null,
  first_registration_precision text not null,
  registration_year smallint not null,
  mileage_km integer not null check (mileage_km >= 0),
  engine_cc integer check (engine_cc > 0),
  power_ps numeric(7,2) not null check (power_ps > 0),
  price_amount numeric(14,2) not null check (price_amount > 0),
  price_currency text not null default 'EUR',
  price_category text not null check (price_category in ('Sehr guter Preis', 'Guter Preis', 'Fairer Preis')),
  fuel_type text,
  transmission text,
  drive text,
  body_type text,
  color text,
  description text,
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  source_url text not null,
  primary_image_url text,
  source_status text not null,
  proof_status text not null,
  is_new_vehicle boolean not null default false,
  catalog_visible boolean not null default false,
  source_updated_at timestamptz,
  last_seen_at timestamptz,
  verified_at timestamptz,
  source_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(source_payload) = 'object'),
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mobile_de_catalog_visibility_requires_approved_data check (
    not catalog_visible or (
      source_status = 'active'
      and proof_status = 'proven_verified'
      and first_registration_precision in ('month', 'day')
      and registration_year between 2022 and 2025
      and power_ps <= 160
      and mileage_km <= 100000
      and price_category in ('Sehr guter Preis', 'Guter Preis', 'Fairer Preis')
      and not is_new_vehicle
    )
  )
);

create table if not exists public.mobile_de_catalog_images (
  id bigint generated always as identity primary key,
  master_id uuid not null references public.mobile_de_catalog_listings(master_id) on delete cascade,
  source_url text not null,
  position integer not null check (position >= 0),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (master_id, position),
  unique (master_id, source_url)
);

create table if not exists public.mobile_de_catalog_import_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  source_candidate_count integer not null default 0 check (source_candidate_count >= 0),
  fetched_count integer not null default 0 check (fetched_count >= 0),
  proven_count integer not null default 0 check (proven_count >= 0),
  rejected_count integer not null default 0 check (rejected_count >= 0),
  upserted_count integer not null default 0 check (upserted_count >= 0),
  cursor text,
  error_summary jsonb not null default '[]'::jsonb check (jsonb_typeof(error_summary) = 'array'),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists mobile_de_visible_make_model_idx
  on public.mobile_de_catalog_listings (make, model, master_id)
  where catalog_visible;
create index if not exists mobile_de_visible_registration_idx
  on public.mobile_de_catalog_listings (registration_year desc, master_id)
  where catalog_visible;
create index if not exists mobile_de_visible_price_idx
  on public.mobile_de_catalog_listings (price_amount, master_id)
  where catalog_visible;
create index if not exists mobile_de_visible_mileage_idx
  on public.mobile_de_catalog_listings (mileage_km, master_id)
  where catalog_visible;
create index if not exists mobile_de_visible_power_idx
  on public.mobile_de_catalog_listings (power_ps, master_id)
  where catalog_visible;
create index if not exists mobile_de_visible_fuel_transmission_body_idx
  on public.mobile_de_catalog_listings (fuel_type, transmission, body_type, master_id)
  where catalog_visible;
create index if not exists mobile_de_catalog_images_listing_position_idx
  on public.mobile_de_catalog_images (master_id, position);
create index if not exists mobile_de_import_runs_status_started_idx
  on public.mobile_de_catalog_import_runs (status, started_at desc);

create or replace function public.get_mobile_de_catalog_facets(p_make text default null)
returns jsonb
language sql
stable
set search_path = public
as $$
  with visible as materialized (
    select make, model, fuel_type, transmission, body_type, price_amount,
           registration_year, production_year, mileage_km, power_ps
    from public.mobile_de_catalog_listings
    where catalog_visible
      and (nullif(btrim(p_make), '') is null or make = p_make)
  )
  select jsonb_build_object(
    'makes', case when nullif(btrim(p_make), '') is null then coalesce((
      select jsonb_agg(make order by make)
      from (select distinct make from visible where nullif(btrim(make), '') is not null) makes
    ), '[]'::jsonb) else null end,
    'models', case when nullif(btrim(p_make), '') is not null then coalesce((
      select jsonb_agg(model order by model)
      from (select distinct model from visible where nullif(btrim(model), '') is not null) models
    ), '[]'::jsonb) else null end,
    'fuel_types', coalesce((select jsonb_agg(value order by value) from (select distinct fuel_type as value from visible where nullif(btrim(fuel_type), '') is not null) values_), '[]'::jsonb),
    'transmissions', coalesce((select jsonb_agg(value order by value) from (select distinct transmission as value from visible where nullif(btrim(transmission), '') is not null) values_), '[]'::jsonb),
    'body_types', coalesce((select jsonb_agg(value order by value) from (select distinct body_type as value from visible where nullif(btrim(body_type), '') is not null) values_), '[]'::jsonb),
    'ranges', jsonb_build_object(
      'count', (select count(*) from visible),
      'price_min', (select min(price_amount) from visible),
      'price_max', (select max(price_amount) from visible),
      'year_min', (select min(production_year) from visible),
      'year_max', (select max(production_year) from visible),
      'registration_year_min', (select min(registration_year) from visible),
      'registration_year_max', (select max(registration_year) from visible),
      'mileage_min', (select min(mileage_km) from visible),
      'mileage_max', (select max(mileage_km) from visible),
      'power_min', (select min(power_ps) from visible),
      'power_max', (select max(power_ps) from visible)
    )
  );
$$;

alter table public.mobile_de_catalog_listings enable row level security;
alter table public.mobile_de_catalog_images enable row level security;
alter table public.mobile_de_catalog_import_runs enable row level security;

revoke all on function public.get_mobile_de_catalog_facets(text) from public, anon, authenticated;
revoke all on public.mobile_de_catalog_listings from anon, authenticated;
revoke all on public.mobile_de_catalog_images from anon, authenticated;
revoke all on public.mobile_de_catalog_import_runs from anon, authenticated;
grant all on public.mobile_de_catalog_listings to service_role;
grant all on public.mobile_de_catalog_images to service_role;
grant all on public.mobile_de_catalog_import_runs to service_role;
grant usage, select on sequence public.mobile_de_catalog_images_id_seq to service_role;
grant execute on function public.get_mobile_de_catalog_facets(text) to service_role;

comment on table public.mobile_de_catalog_listings is
  'Europe-only Mobile.de catalogue. Rows stay hidden until verified active eligibility is confirmed.';
comment on table public.mobile_de_catalog_images is
  'Ordered Mobile.de gallery URLs for Europe-only catalogue rows.';
comment on table public.mobile_de_catalog_import_runs is
  'Resumable imports of proven active Mobile.de listings into the separate Europe catalogue tables.';
