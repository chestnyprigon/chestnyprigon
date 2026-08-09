create table public.vehicle_reports (
  vehicle_id uuid primary key references public.vehicles(id) on delete cascade,
  canonical_vehicle_id text not null,
  options jsonb not null default '[]'::jsonb,
  inspection_summary jsonb not null default '{}'::jsonb,
  accident_summary jsonb not null default '{}'::jsonb,
  report_status text not null default 'ready' check (report_status in ('ready', 'partial', 'unavailable')),
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger vehicle_reports_set_updated_at
before update on public.vehicle_reports
for each row execute function public.set_updated_at();

create index vehicle_reports_canonical_vehicle_idx on public.vehicle_reports (canonical_vehicle_id);

alter table public.vehicle_reports enable row level security;
revoke all on public.vehicle_reports from anon, authenticated;
grant select on public.vehicle_reports to anon, authenticated;

create policy "Public can read reports of approved active vehicles"
on public.vehicle_reports for select
to anon, authenticated
using (exists (
  select 1 from public.vehicles
  where vehicles.id = vehicle_reports.vehicle_id
    and vehicles.is_public
    and vehicles.status = 'active'
));

drop view public.catalog_vehicles;

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
  vehicle.vin_masked,
  vehicle.source_url,
  vehicle.source_updated_at,
  vehicle.published_at,
  vehicle.last_seen_at,
  coalesce(images.urls, '{}'::text[]) as image_urls,
  report.options as report_options,
  report.inspection_summary,
  report.accident_summary,
  report.report_status,
  report.fetched_at as report_fetched_at
from public.vehicles vehicle
left join lateral (
  select array_agg(image.source_url order by image.position) as urls
  from public.vehicle_images image
  where image.vehicle_id = vehicle.id
) images on true
left join public.vehicle_reports report on report.vehicle_id = vehicle.id
where vehicle.is_public and vehicle.status = 'active';

grant select on public.catalog_vehicles to anon, authenticated;

comment on table public.vehicle_reports is 'Public-safe normalized Encar options, inspection and accident report summaries. Raw reports remain outside this table.';
