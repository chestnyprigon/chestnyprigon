-- The catalogue uses the existing `removed` status for archived listings.
-- Keep the row and its images; only remove it from the active/public view.
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
      revalidation_miss_count = 0,
      removed_at = null
  where source_listing_id = any(coalesce(p_found_source_listing_ids, '{}'::text[]));
  get diagnostics v_found = row_count;

  update public.vehicles
  set last_checked_at = p_checked_at,
      revalidation_miss_count = revalidation_miss_count + 1,
      is_public = case when revalidation_miss_count + 1 >= 2 then false else is_public end,
      status = case when revalidation_miss_count + 1 >= p_archive_after then 'removed' else status end,
      removed_at = case when revalidation_miss_count + 1 >= p_archive_after then p_checked_at else removed_at end
  where source_listing_id = any(coalesce(p_missing_source_listing_ids, '{}'::text[]));
  get diagnostics v_missing = row_count;

  select count(*)::integer into v_archived
  from public.vehicles
  where source_listing_id = any(coalesce(p_missing_source_listing_ids, '{}'::text[]))
    and revalidation_miss_count >= p_archive_after
    and status = 'removed';

  return query select v_found, v_missing, v_archived;
end;
$$;

revoke all on function public.apply_catalog_revalidation(text[], text[], timestamptz, integer) from public;
grant execute on function public.apply_catalog_revalidation(text[], text[], timestamptz, integer) to service_role;
