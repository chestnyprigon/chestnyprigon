create index if not exists vehicles_public_monitor_queue_idx
  on public.vehicles (last_checked_at asc nulls first, source_listing_id asc)
  where status = 'active' and is_public = true;
