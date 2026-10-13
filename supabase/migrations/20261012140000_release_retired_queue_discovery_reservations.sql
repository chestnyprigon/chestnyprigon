begin;

-- Retain queue history while explicitly releasing unused search reservations.
-- Merely cancelling a run does not release any identifier.
alter table public.chestny_enrichment_queue
  add column if not exists discovery_release jsonb;
alter table public.chestny_enrichment_queue
  add constraint chestny_queue_discovery_release_check check (
    discovery_release is null or (
      status in ('failed', 'cancelled')
      and jsonb_typeof(discovery_release) = 'object'
      and nullif(discovery_release->>'reason', '') is not null
      and nullif(discovery_release->>'retiredRunId', '') is not null
      and nullif(discovery_release->>'releasedAt', '') is not null
    )
  );

create view public.chestny_discovery_reserved_queue
with (security_invoker = true) as
select id, run_id, source_listing_id, status
from public.chestny_enrichment_queue
where discovery_release is null or status not in ('failed', 'cancelled');
revoke all on public.chestny_discovery_reserved_queue from public, anon, authenticated;
grant select on public.chestny_discovery_reserved_queue to service_role;

-- Preserve the deployed function, including all existing ID/quota/offset guards.
do $$
declare
  definition text;
  old_filter text := 'from public.chestny_enrichment_queue q where q.source_listing_id=x.source_listing_id';
  new_filter text := 'from public.chestny_discovery_reserved_queue q where q.source_listing_id=x.source_listing_id';
begin
  definition := pg_get_functiondef('public.record_chestny_catalog_search_page(uuid,text,uuid,integer,integer,integer,jsonb,boolean)'::regprocedure);
  if strpos(definition, old_filter) = 0 then
    raise exception 'Search reservation filter changed; inspect the deployed function before migrating';
  end if;
  execute replace(definition, old_filter, new_filter);
end;
$$;

notify pgrst, 'reload schema';
commit;
