create table if not exists public.catalog_price_changes (
  id bigint generated always as identity primary key,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  source_listing_id text not null,
  old_price_krw bigint not null check (old_price_krw > 0),
  new_price_krw bigint not null check (new_price_krw > 0),
  source_updated_at timestamptz,
  detected_at timestamptz not null default now()
);

create index if not exists catalog_price_changes_vehicle_detected_idx
  on public.catalog_price_changes (vehicle_id, detected_at desc);

alter table public.catalog_price_changes enable row level security;
revoke all on public.catalog_price_changes from anon, authenticated;
