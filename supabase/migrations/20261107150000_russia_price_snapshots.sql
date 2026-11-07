create table public.russia_price_snapshots (
  source text not null check (source in ('korea', 'europe')),
  listing_id text not null,
  destination text not null default 'RU' check (destination = 'RU'),
  status text not null default 'pending' check (status in ('pending', 'ready', 'stale', 'failed')),
  revision bigint not null default 1 check (revision > 0),
  calculation jsonb check (calculation is null or jsonb_typeof(calculation) = 'object'),
  calculated_at timestamptz,
  last_attempt_at timestamptz,
  next_refresh_at timestamptz not null default now(),
  last_error_code text,
  updated_at timestamptz not null default now(),
  primary key (source, listing_id, destination),
  check ((status = 'ready' and calculation is not null and calculated_at is not null) or status <> 'ready')
);

create index russia_price_snapshots_next_refresh_idx
  on public.russia_price_snapshots (next_refresh_at, source, listing_id);

alter table public.russia_price_snapshots enable row level security;
revoke all on public.russia_price_snapshots from public, anon, authenticated;
grant select, insert, update, delete on public.russia_price_snapshots to service_role;

comment on table public.russia_price_snapshots is
  'One current Russian preliminary price snapshot per catalogue listing. Failed refreshes retain the last successful calculation; no calculation history is stored.';

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
      and new.proof_status = 'proven_verified'
      and new.catalog_visible;
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

create trigger vehicles_queue_russia_price_insert
after insert on public.vehicles
for each row execute function public.queue_russia_price_snapshot();

create trigger vehicles_queue_russia_price_update
after update of id, source_listing_id, manufacturer, model, generation, trim, model_year,
  first_registration_date, engine_cc, fuel_type, drive_type, price_krw, is_public, status,
  engine_power_ps, engine_power_kw, electric_motor_peak_kw, electric_30min_kw,
  system_combined_power_kw, power_basis, power_confidence, power_source_type, power_source_url
on public.vehicles
for each row execute function public.queue_russia_price_snapshot();

create trigger mobile_de_queue_russia_price_insert
after insert on public.mobile_de_catalog_listings
for each row execute function public.queue_russia_price_snapshot();

create trigger mobile_de_queue_russia_price_update
after update of master_id, title, make, model, production_year, first_registration, engine_cc,
  power_ps, price_amount, fuel_type, drive, source_status, proof_status, catalog_visible
on public.mobile_de_catalog_listings
for each row execute function public.queue_russia_price_snapshot();

revoke all on function public.queue_russia_price_snapshot() from public, anon, authenticated;

-- Seed one queue row per already-published catalogue listing for the initial
-- controlled backfill. The queue itself stays bounded to the active catalogs.
insert into public.russia_price_snapshots (source, listing_id, destination, status, next_refresh_at)
select 'korea', id::text, 'RU', 'pending', now()
from public.vehicles
where status = 'active' and is_public
on conflict (source, listing_id, destination) do nothing;

insert into public.russia_price_snapshots (source, listing_id, destination, status, next_refresh_at)
select 'europe', master_id::text, 'RU', 'pending', now()
from public.mobile_de_catalog_listings
where source_status = 'active' and proof_status = 'proven_verified' and catalog_visible
on conflict (source, listing_id, destination) do nothing;
