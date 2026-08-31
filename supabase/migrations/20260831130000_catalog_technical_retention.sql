create or replace function public.cleanup_catalog_technical_data(p_cutoff timestamptz)
returns table (deleted_orphan_raw integer, deleted_reports integer, deleted_screening integer, deleted_import_runs integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  orphan_raw integer := 0;
  reports integer := 0;
  screening integer := 0;
  runs integer := 0;
begin
  if p_cutoff is null or p_cutoff > now() then
    raise exception 'cleanup cutoff must be in the past';
  end if;

  -- Raw rows without a vehicle are rejected/import-only data. They are safe
  -- to remove after the retention period; catalog rows reference raw rows
  -- with ON DELETE RESTRICT and therefore cannot be touched here.
  delete from public.encar_raw_listings raw
  where raw.last_seen_at < p_cutoff
    and not exists (
      select 1 from public.vehicles vehicle
      where vehicle.source_listing_id = raw.source_listing_id
    );
  get diagnostics orphan_raw = row_count;

  -- Reports are only needed for vehicles currently in the catalog. Keep all
  -- reports belonging to active vehicles, including hidden active vehicles.
  delete from public.vehicle_reports report
  using public.vehicles vehicle
  where vehicle.id = report.vehicle_id
    and vehicle.status <> 'active'
    and report.updated_at < p_cutoff;
  get diagnostics reports = row_count;

  -- Screening rows for removed vehicles (or orphan raw rows) are rebuildable
  -- and are not needed for publication of active vehicles.
  delete from public.listing_screening screening_row
  where screening_row.screened_at < p_cutoff
    and not exists (
      select 1
      from public.vehicles vehicle
      where vehicle.source_listing_id = screening_row.source_listing_id
        and vehicle.status = 'active'
    );
  get diagnostics screening = row_count;

  delete from public.import_runs run
  where run.created_at < p_cutoff
    and run.status in ('completed', 'failed', 'cancelled');
  get diagnostics runs = row_count;

  return query select orphan_raw, reports, screening, runs;
end;
$$;

revoke all on function public.cleanup_catalog_technical_data(timestamptz) from public;
