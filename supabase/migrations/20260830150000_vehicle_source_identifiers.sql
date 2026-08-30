create table if not exists public.vehicle_source_identifiers (
  source_identifier text primary key,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  identifier_type text not null check (identifier_type in ('canonical', 'search', 'detail')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists vehicle_source_identifiers_vehicle_idx
  on public.vehicle_source_identifiers (vehicle_id);

insert into public.vehicle_source_identifiers (source_identifier, vehicle_id, identifier_type, first_seen_at, last_seen_at)
select source_listing_id, id, 'canonical', first_seen_at, last_seen_at
from public.vehicles
on conflict (source_identifier) do nothing;

insert into public.vehicle_source_identifiers (source_identifier, vehicle_id, identifier_type, first_seen_at, last_seen_at)
select match[1], id, 'search', first_seen_at, last_seen_at
from (
  select id, first_seen_at, last_seen_at,
    regexp_match(source_url, '[?&]carid=([0-9]+)') as match
  from public.vehicles
) vehicles_with_ids
where match is not null
on conflict (source_identifier) do nothing;

alter table public.vehicle_source_identifiers enable row level security;
revoke all on public.vehicle_source_identifiers from anon, authenticated;
grant select, insert, update, delete on public.vehicle_source_identifiers to service_role;
