create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create table public.import_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  source text not null default 'encar' check (source = 'encar'),
  mode text not null check (mode in ('initial', 'incremental', 'refresh')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  fetched_count integer not null default 0 check (fetched_count >= 0),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  rejected_count integer not null default 0 check (rejected_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  cursor jsonb not null default '{}'::jsonb,
  error_summary jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table public.encar_raw_listings (
  source_listing_id text primary key,
  import_run_id uuid references public.import_runs(id) on delete set null,
  source_url text,
  payload jsonb not null,
  payload_hash text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.listing_screening (
  source_listing_id text primary key references public.encar_raw_listings(source_listing_id) on delete cascade,
  decision text not null check (decision in ('pending', 'approved', 'rejected', 'manual_review')),
  is_lease boolean not null default false,
  is_rental boolean not null default false,
  is_taxi boolean not null default false,
  is_commercial boolean not null default false,
  is_problematic boolean not null default false,
  reason_codes text[] not null default '{}',
  rules_version text not null,
  screened_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);

create table public.vehicles (
  id uuid primary key default extensions.gen_random_uuid(),
  source text not null default 'encar' check (source = 'encar'),
  source_listing_id text not null unique references public.encar_raw_listings(source_listing_id) on delete restrict,
  manufacturer text not null,
  model text not null,
  generation text,
  trim text,
  model_year smallint not null check (model_year between 1990 and 2100),
  first_registration_date date,
  mileage_km integer not null check (mileage_km >= 0),
  price_krw bigint not null check (price_krw > 0),
  price_usd integer check (price_usd > 0),
  krw_per_usd numeric(12,4) check (krw_per_usd > 0),
  engine_cc integer check (engine_cc > 0),
  fuel_type text not null,
  transmission text,
  drive_type text,
  body_type text,
  exterior_color text,
  location text,
  vin_masked text,
  status text not null default 'active' check (status in ('active', 'reserved', 'sold', 'removed', 'hidden')),
  is_public boolean not null default false,
  source_url text not null,
  source_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  published_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint public_vehicle_must_be_active check (not is_public or status = 'active')
);

create table public.vehicle_images (
  id bigint generated always as identity primary key,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  source_url text not null,
  storage_path text,
  position smallint not null default 0 check (position >= 0),
  width integer check (width > 0),
  height integer check (height > 0),
  created_at timestamptz not null default now(),
  unique (vehicle_id, position),
  unique (vehicle_id, source_url)
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger encar_raw_listings_set_updated_at
before update on public.encar_raw_listings
for each row execute function public.set_updated_at();

create trigger vehicles_set_updated_at
before update on public.vehicles
for each row execute function public.set_updated_at();

create or replace function public.enforce_vehicle_publication()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_public then
    if not exists (
      select 1
      from public.listing_screening screening
      where screening.source_listing_id = new.source_listing_id
        and screening.decision = 'approved'
        and not screening.is_lease
        and not screening.is_rental
        and not screening.is_taxi
        and not screening.is_commercial
        and not screening.is_problematic
    ) then
      raise exception 'Listing % has not passed publication screening', new.source_listing_id;
    end if;
    new.published_at = coalesce(new.published_at, now());
  end if;
  return new;
end;
$$;

create trigger vehicles_enforce_publication
before insert or update of is_public, source_listing_id on public.vehicles
for each row execute function public.enforce_vehicle_publication();

create index import_runs_status_started_idx on public.import_runs (status, started_at desc);
create index raw_listings_run_idx on public.encar_raw_listings (import_run_id);
create index raw_listings_last_seen_idx on public.encar_raw_listings (last_seen_at desc);
create index screening_decision_idx on public.listing_screening (decision, screened_at desc);
create index vehicles_public_sort_idx on public.vehicles (is_public, status, model_year desc, price_usd, mileage_km);
create index vehicles_brand_model_idx on public.vehicles (manufacturer, model, model_year desc) where is_public and status = 'active';
create index vehicles_last_seen_idx on public.vehicles (last_seen_at desc);
create index vehicles_search_trgm_idx on public.vehicles using gin ((manufacturer || ' ' || model || ' ' || coalesce(trim, '')) extensions.gin_trgm_ops);
create index vehicle_images_vehicle_position_idx on public.vehicle_images (vehicle_id, position);

alter table public.import_runs enable row level security;
alter table public.encar_raw_listings enable row level security;
alter table public.listing_screening enable row level security;
alter table public.vehicles enable row level security;
alter table public.vehicle_images enable row level security;

revoke all on public.import_runs from anon, authenticated;
revoke all on public.encar_raw_listings from anon, authenticated;
revoke all on public.listing_screening from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.vehicles from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.vehicle_images from anon, authenticated;
grant select on public.vehicles to anon, authenticated;
grant select on public.vehicle_images to anon, authenticated;

create policy "Public can read approved active vehicles"
on public.vehicles for select
to anon, authenticated
using (is_public and status = 'active');

create policy "Public can read images of approved active vehicles"
on public.vehicle_images for select
to anon, authenticated
using (exists (
  select 1 from public.vehicles
  where vehicles.id = vehicle_images.vehicle_id
    and vehicles.is_public
    and vehicles.status = 'active'
));

create view public.catalog_vehicles
with (security_invoker = true)
as
select
  vehicle.id,
  vehicle.source_listing_id,
  vehicle.manufacturer,
  vehicle.model,
  vehicle.generation,
  vehicle.trim,
  vehicle.model_year,
  vehicle.first_registration_date,
  vehicle.mileage_km,
  vehicle.price_krw,
  vehicle.price_usd,
  vehicle.engine_cc,
  vehicle.fuel_type,
  vehicle.transmission,
  vehicle.drive_type,
  vehicle.body_type,
  vehicle.exterior_color,
  vehicle.location,
  vehicle.source_url,
  vehicle.published_at,
  vehicle.last_seen_at,
  coalesce(images.urls, '{}'::text[]) as image_urls
from public.vehicles vehicle
left join lateral (
  select array_agg(image.source_url order by image.position) as urls
  from public.vehicle_images image
  where image.vehicle_id = vehicle.id
) images on true
where vehicle.is_public and vehicle.status = 'active';

grant select on public.catalog_vehicles to anon, authenticated;

comment on table public.encar_raw_listings is 'Private immutable-ish staging data received from Encar before normalization.';
comment on table public.listing_screening is 'Private screening decision. Rejected listings never become public catalog entries.';
comment on view public.catalog_vehicles is 'Public read model for the Korea-only website catalog.';
