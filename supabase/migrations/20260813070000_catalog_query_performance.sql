-- Fast path for the public catalogue. Full Encar reports and all photographs
-- are intentionally kept out of the listing query and loaded only per page.
create index if not exists vehicles_public_catalog_published_idx
on public.vehicles (published_at desc, id desc)
where is_public and status = 'active';

create index if not exists vehicles_public_catalog_price_idx
on public.vehicles (price_usd asc, id desc)
where is_public and status = 'active';

create index if not exists vehicles_public_catalog_filters_idx
on public.vehicles (manufacturer, model, model_year, fuel_type, mileage_km)
where is_public and status = 'active';

create index if not exists vehicle_reports_vehicle_accident_idx
on public.vehicle_reports (vehicle_id);

comment on index public.vehicles_public_catalog_published_idx is
'Supports newest-first public catalogue pagination without joining reports or image aggregates.';
