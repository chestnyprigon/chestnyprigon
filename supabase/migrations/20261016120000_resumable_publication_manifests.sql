begin;

create table public.chestny_catalog_publication_manifests (
  id uuid primary key default extensions.gen_random_uuid(),
  run_id uuid not null references public.chestny_enrichment_runs(id) on delete restrict,
  selected_source_ids_sha256 text not null check (selected_source_ids_sha256 ~ '^[0-9a-f]{64}$'),
  source_cohort_sha256 text check (source_cohort_sha256 is null or source_cohort_sha256 ~ '^[0-9a-f]{64}$'),
  selected_count integer not null check (selected_count > 0),
  status text not null default 'prepared'
    check (status in ('prepared', 'publishing', 'paused', 'completed')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_error jsonb,
  unique (run_id, selected_source_ids_sha256),
  unique (id, run_id)
);

create table public.chestny_catalog_publication_manifest_items (
  id uuid primary key default extensions.gen_random_uuid(),
  manifest_id uuid not null references public.chestny_catalog_publication_manifests(id) on delete restrict,
  position integer not null check (position > 0),
  source_listing_id text not null,
  canonical_id text not null,
  manufacturer text not null,
  status text not null default 'pending'
    check (status in ('pending', 'publishing', 'published', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_until timestamptz,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  published_at timestamptz,
  last_error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (manifest_id, position),
  unique (manifest_id, source_listing_id),
  unique (manifest_id, canonical_id)
);

create index chestny_catalog_publication_manifest_items_status_idx
  on public.chestny_catalog_publication_manifest_items (manifest_id, status, lease_until, position);
create index chestny_catalog_publication_manifest_items_vehicle_idx
  on public.chestny_catalog_publication_manifest_items (vehicle_id)
  where vehicle_id is not null;

alter table public.chestny_catalog_publication_manifests enable row level security;
alter table public.chestny_catalog_publication_manifest_items enable row level security;
revoke all on public.chestny_catalog_publication_manifests from public, anon, authenticated;
revoke all on public.chestny_catalog_publication_manifest_items from public, anon, authenticated;
grant all on public.chestny_catalog_publication_manifests to service_role;
grant all on public.chestny_catalog_publication_manifest_items to service_role;
revoke insert, update, delete, truncate, references, trigger on public.chestny_catalog_publication_manifests from service_role;
revoke insert, update, delete, truncate, references, trigger on public.chestny_catalog_publication_manifest_items from service_role;
grant select on public.chestny_catalog_publication_manifests to service_role;
grant select on public.chestny_catalog_publication_manifest_items to service_role;

create or replace function public.guard_chestny_catalog_publication_manifest()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Publication manifest is immutable and cannot be deleted';
  end if;
  if new.id is distinct from old.id
    or new.run_id is distinct from old.run_id
    or new.selected_source_ids_sha256 is distinct from old.selected_source_ids_sha256
    or new.source_cohort_sha256 is distinct from old.source_cohort_sha256
    or new.selected_count is distinct from old.selected_count
    or new.created_at is distinct from old.created_at then
    raise exception 'Publication manifest identity is immutable';
  end if;
  return new;
end;
$$;

create trigger chestny_catalog_publication_manifest_guard
before update or delete on public.chestny_catalog_publication_manifests
for each row execute function public.guard_chestny_catalog_publication_manifest();

create or replace function public.guard_chestny_catalog_publication_manifest_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Publication manifest roster is immutable and cannot be deleted';
  end if;
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.manifest_id is distinct from old.manifest_id
    or new.position is distinct from old.position
    or new.source_listing_id is distinct from old.source_listing_id
    or new.canonical_id is distinct from old.canonical_id
    or new.manufacturer is distinct from old.manufacturer
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'Publication manifest roster is immutable';
  end if;
  if tg_op = 'INSERT' and exists (
    select 1 from public.chestny_catalog_publication_manifests m
    where m.id = new.manifest_id and m.status <> 'prepared'
  ) then
    raise exception 'Cannot add roster items after publication has started';
  end if;
  return new;
end;
$$;

create trigger chestny_catalog_publication_manifest_item_guard
before insert or update or delete on public.chestny_catalog_publication_manifest_items
for each row execute function public.guard_chestny_catalog_publication_manifest_item();

create or replace function public.register_chestny_catalog_publication_manifest(
  p_run_id uuid,
  p_selected_source_ids_sha256 text,
  p_source_cohort_sha256 text,
  p_items jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_manifest_id uuid;
  v_count integer;
  v_run_status text;
  v_manifest_status text;
  v_roster_hash text;
begin
  if p_selected_source_ids_sha256 !~ '^[0-9a-f]{64}$'
    or (p_source_cohort_sha256 is not null and p_source_cohort_sha256 !~ '^[0-9a-f]{64}$')
    or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) = 0 then
    raise exception 'Invalid publication manifest metadata';
  end if;

  select r.status into v_run_status
  from public.chestny_enrichment_runs r
  where r.id = p_run_id;
  if not found or v_run_status not in ('running', 'paused', 'completed') then
    raise exception 'Enrichment run is not eligible for screened-cohort publication';
  end if;

  select count(*)::integer into v_count
  from jsonb_to_recordset(p_items) as x(position integer, source_listing_id text, canonical_id text, manufacturer text);
  select encode(extensions.digest(convert_to(string_agg(x.source_listing_id, E'\n' order by x.position), 'UTF8'), 'sha256'), 'hex')
    into v_roster_hash
  from jsonb_to_recordset(p_items) as x(position integer, source_listing_id text, canonical_id text, manufacturer text);
  if v_count <> jsonb_array_length(p_items)
    or v_roster_hash <> p_selected_source_ids_sha256
    or exists (
      select 1 from jsonb_to_recordset(p_items) as x(position integer, source_listing_id text, canonical_id text, manufacturer text)
      where x.position is null or x.position < 1 or nullif(x.source_listing_id, '') is null
        or nullif(x.canonical_id, '') is null or nullif(x.manufacturer, '') is null
    )
    or (select count(distinct x.source_listing_id) from jsonb_to_recordset(p_items) as x(position integer, source_listing_id text, canonical_id text, manufacturer text)) <> v_count
    or (select count(distinct x.canonical_id) from jsonb_to_recordset(p_items) as x(position integer, source_listing_id text, canonical_id text, manufacturer text)) <> v_count
    or (select count(distinct x.position) from jsonb_to_recordset(p_items) as x(position integer, source_listing_id text, canonical_id text, manufacturer text)) <> v_count
    or (select min(x.position) from jsonb_to_recordset(p_items) as x(position integer, source_listing_id text, canonical_id text, manufacturer text)) <> 1
    or (select max(x.position) from jsonb_to_recordset(p_items) as x(position integer, source_listing_id text, canonical_id text, manufacturer text)) <> v_count then
    raise exception 'Publication manifest roster contains missing or duplicate values';
  end if;

  insert into public.chestny_catalog_publication_manifests(
    run_id, selected_source_ids_sha256, source_cohort_sha256, selected_count
  ) values (p_run_id, p_selected_source_ids_sha256, p_source_cohort_sha256, v_count)
  on conflict (run_id, selected_source_ids_sha256) do nothing;

  select m.id, m.status into v_manifest_id, v_manifest_status
  from public.chestny_catalog_publication_manifests m
  where m.run_id = p_run_id and m.selected_source_ids_sha256 = p_selected_source_ids_sha256
  for update;

  if not found then raise exception 'Could not create publication manifest'; end if;
  if exists (
    select 1 from public.chestny_catalog_publication_manifests m
    where m.id = v_manifest_id and (m.selected_count <> v_count
      or m.source_cohort_sha256 is distinct from p_source_cohort_sha256)
  ) then
    raise exception 'Existing publication manifest metadata does not match';
  end if;

  if v_manifest_status = 'prepared' then
    insert into public.chestny_catalog_publication_manifest_items(
      manifest_id, position, source_listing_id, canonical_id, manufacturer
    )
    select v_manifest_id, x.position, x.source_listing_id, x.canonical_id, x.manufacturer
    from jsonb_to_recordset(p_items) as x(position integer, source_listing_id text, canonical_id text, manufacturer text)
    on conflict (manifest_id, source_listing_id) do nothing;
  end if;

  if (select count(*) from public.chestny_catalog_publication_manifest_items i where i.manifest_id = v_manifest_id) <> v_count
    or exists (
      select 1
      from jsonb_to_recordset(p_items) as x(position integer, source_listing_id text, canonical_id text, manufacturer text)
      full join public.chestny_catalog_publication_manifest_items i
        on i.manifest_id = v_manifest_id and i.source_listing_id = x.source_listing_id
      where x.source_listing_id is null or i.source_listing_id is null
        or i.position <> x.position or i.canonical_id <> x.canonical_id or i.manufacturer <> x.manufacturer
    ) then
    raise exception 'Existing publication manifest roster does not match the requested cohort';
  end if;
  return v_manifest_id;
end;
$$;

create or replace function public.claim_chestny_catalog_publication_items(
  p_manifest_id uuid,
  p_limit integer default 10,
  p_lease_minutes integer default 30,
  p_retry_exhausted boolean default false
) returns setof public.chestny_catalog_publication_manifest_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_limit is null or p_limit < 1 or p_lease_minutes is null or p_lease_minutes < 1 then
    raise exception 'Claim limit and lease duration must be positive integers';
  end if;
  select m.status into v_status
  from public.chestny_catalog_publication_manifests m
  where m.id = p_manifest_id
  for update;
  if not found or v_status not in ('prepared', 'publishing', 'paused') then
    raise exception 'Publication manifest is not open for item claims';
  end if;
  update public.chestny_catalog_publication_manifests
  set status = 'publishing', started_at = coalesce(started_at, now()), last_error = null
  where id = p_manifest_id;

  return query
  with candidates as (
    select i.id
    from public.chestny_catalog_publication_manifest_items i
    where i.manifest_id = p_manifest_id
      and (i.status = 'pending'
        or (i.status = 'failed' and (i.attempt_count < 3 or p_retry_exhausted))
        or (i.status = 'publishing' and i.lease_until < now()))
    order by i.position
    for update skip locked
    limit p_limit
  )
  update public.chestny_catalog_publication_manifest_items i
  set status = 'publishing', attempt_count = i.attempt_count + 1,
      lease_until = now() + make_interval(mins => p_lease_minutes), last_error = null, updated_at = now()
  from candidates c
  where i.id = c.id
  returning i.*;
end;
$$;

create or replace function public.finish_chestny_catalog_publication_item(
  p_manifest_id uuid,
  p_source_listing_id text,
  p_status text,
  p_vehicle_id uuid default null,
  p_error jsonb default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('published', 'failed') then raise exception 'Invalid publication item result'; end if;
  update public.chestny_catalog_publication_manifest_items i
  set status = p_status,
      vehicle_id = coalesce(p_vehicle_id, i.vehicle_id),
      published_at = case when p_status = 'published' then coalesce(i.published_at, now()) else i.published_at end,
      lease_until = null,
      last_error = case when p_status = 'failed' then coalesce(p_error, '{}'::jsonb) else null end,
      updated_at = now()
  where i.manifest_id = p_manifest_id and i.source_listing_id = p_source_listing_id and i.status = 'publishing';
  if not found then raise exception 'Publication item is not currently leased'; end if;
end;
$$;

create or replace function public.set_chestny_catalog_publication_manifest_status(
  p_manifest_id uuid,
  p_status text,
  p_error jsonb default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_open integer;
begin
  if p_status not in ('paused', 'completed') then raise exception 'Invalid publication manifest status'; end if;
  select count(*)::integer into v_open
  from public.chestny_catalog_publication_manifest_items i
  where i.manifest_id = p_manifest_id and i.status <> 'published';
  if p_status = 'completed' and v_open <> 0 then
    raise exception 'Cannot complete publication manifest with unfinished items';
  end if;
  update public.chestny_catalog_publication_manifests
  set status = p_status,
      completed_at = case when p_status = 'completed' then now() else null end,
      last_error = p_error
  where id = p_manifest_id;
  if not found then raise exception 'Publication manifest not found'; end if;
end;
$$;

revoke all on function public.register_chestny_catalog_publication_manifest(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_chestny_catalog_publication_items(uuid, integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.finish_chestny_catalog_publication_item(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.set_chestny_catalog_publication_manifest_status(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.register_chestny_catalog_publication_manifest(uuid, text, text, jsonb) to service_role;
grant execute on function public.claim_chestny_catalog_publication_items(uuid, integer, integer, boolean) to service_role;
grant execute on function public.finish_chestny_catalog_publication_item(uuid, text, text, uuid, jsonb) to service_role;
grant execute on function public.set_chestny_catalog_publication_manifest_status(uuid, text, jsonb) to service_role;

commit;
