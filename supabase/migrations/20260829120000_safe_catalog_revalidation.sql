alter table public.vehicles
  add column if not exists last_checked_at timestamptz,
  add column if not exists revalidation_miss_count integer not null default 0;

create index if not exists vehicles_revalidation_idx
  on public.vehicles (last_checked_at desc, revalidation_miss_count desc);

create or replace function public.apply_catalog_revalidation(
  p_found_source_listing_ids text[],
  p_missing_source_listing_ids text[],
  p_checked_at timestamptz,
  p_archive_after integer default 3
)
returns table (found_count integer, missing_count integer, archived_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_found integer := 0;
  v_missing integer := 0;
  v_archived integer := 0;
begin
  update public.vehicles
  set last_seen_at = p_checked_at,
      last_checked_at = p_checked_at,
      revalidation_miss_count = 0
  where source_listing_id = any(coalesce(p_found_source_listing_ids, '{}'::text[]));
  get diagnostics v_found = row_count;

  update public.vehicles
  set last_checked_at = p_checked_at,
      revalidation_miss_count = revalidation_miss_count + 1,
      is_public = case when revalidation_miss_count + 1 >= p_archive_after then false else is_public end,
      status = case when revalidation_miss_count + 1 >= p_archive_after then 'archived' else status end
  where source_listing_id = any(coalesce(p_missing_source_listing_ids, '{}'::text[]));
  get diagnostics v_missing = row_count;

  select count(*)::integer into v_archived
  from public.vehicles
  where source_listing_id = any(coalesce(p_missing_source_listing_ids, '{}'::text[]))
    and revalidation_miss_count >= p_archive_after
    and status = 'archived';
  return query select v_found, v_missing, v_archived;
end;
$$;

revoke all on function public.apply_catalog_revalidation(text[], text[], timestamptz, integer) from public;
grant execute on function public.apply_catalog_revalidation(text[], text[], timestamptz, integer) to service_role;
