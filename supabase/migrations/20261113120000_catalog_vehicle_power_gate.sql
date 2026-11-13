-- Keep Vehicle Power research outcomes auditable per candidate and require
-- source-backed, TKS-compatible power on newly published Encar vehicles.
create table if not exists public.chestny_catalog_power_resolutions (
  id uuid primary key default extensions.gen_random_uuid(),
  run_id uuid not null references public.chestny_enrichment_runs(id) on delete cascade,
  wave_id uuid references public.chestny_enrichment_waves(id) on delete set null,
  source_listing_id text not null,
  status text not null check (status in ('resolved','not_found','ambiguous','research_pending','retryable_error','incompatible_power')),
  reason_code text not null,
  reason_detail text,
  configuration_fingerprint text,
  reference_version text,
  power_record jsonb,
  response jsonb,
  attempt_count integer not null default 1 check (attempt_count > 0),
  first_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (run_id, source_listing_id),
  check ((status = 'resolved') = (power_record is not null))
);

create index if not exists chestny_catalog_power_run_status_idx
  on public.chestny_catalog_power_resolutions (run_id, status);
create index if not exists chestny_catalog_power_wave_status_idx
  on public.chestny_catalog_power_resolutions (run_id, wave_id, status);

alter table public.chestny_catalog_power_resolutions enable row level security;
revoke all on public.chestny_catalog_power_resolutions from anon, authenticated;
grant all on public.chestny_catalog_power_resolutions to service_role;

create or replace function public.require_vehicle_power_for_new_encar_publication()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fuel text := lower(coalesce(new.fuel_type, ''));
  v_power_gate boolean := false;
  v_hybrid boolean;
  v_electric boolean;
begin
  if new.is_public is not true or (tg_op = 'UPDATE' and old.is_public is true) then
    return new;
  end if;
  if new.catalog_launch_id is not null then
    select coalesce(rules->>'powerGate' = 'vehicle_power_required', false)
      into v_power_gate from public.chestny_catalog_launches where id = new.catalog_launch_id;
  end if;
  if not v_power_gate then return new; end if;
  if coalesce(new.source_url, '') not ilike '%encar.com%' then
    return new;
  end if;

  v_hybrid := v_fuel like '%hybrid%' or v_fuel like '%hev%' or v_fuel like '%phev%'
    or v_fuel like '%하이브리드%' or v_fuel like '%플러그인%'
    or v_fuel like '%가솔린%전기%' or v_fuel like '%디젤%전기%';
  v_electric := v_fuel like '%electric%' or v_fuel like '%ev%' or v_fuel like '%전기%';

  if coalesce(new.power_source_type, '') <> 'vehicle_power'
    or coalesce(new.power_source_url, '') = ''
    or coalesce(new.power_confidence, '') not in ('confirmed','probable','estimated') then
    raise exception 'encar_publication_requires_vehicle_power_source';
  end if;

  if v_electric and not v_hybrid then
    if new.electric_30min_kw is null or new.power_basis <> 'electric_30min' then
      raise exception 'encar_publication_requires_electric_30min_power';
    end if;
  elsif v_hybrid then
    if new.engine_power_kw is null or new.electric_30min_kw is null
      or new.power_basis not in ('combustion_rated','combustion_rated_preliminary','electric_30min','system_combined') then
      raise exception 'encar_publication_requires_hybrid_combustion_and_electric_30min_power';
    end if;
  elsif new.engine_power_kw is null or new.power_basis not in ('combustion_rated','combustion_rated_preliminary') then
    raise exception 'encar_publication_requires_combustion_power';
  end if;
  return new;
end;
$$;

drop trigger if exists vehicles_require_power_for_new_encar_publication on public.vehicles;
create trigger vehicles_require_power_for_new_encar_publication
before insert or update of is_public on public.vehicles
for each row execute function public.require_vehicle_power_for_new_encar_publication();
