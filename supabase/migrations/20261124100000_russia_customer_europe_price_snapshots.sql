-- Public customer-selected Europe listings are eligible for Russia estimates
-- whenever they are active and visible, just like proven legacy listings.
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
      and new.catalog_visible
      and (
        new.proof_status = 'proven_verified'
        or (new.proof_status = 'customer_selected' and new.customer_cohort = 'customer_europe_2026')
      );
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

revoke all on function public.queue_russia_price_snapshot() from public, anon, authenticated;
