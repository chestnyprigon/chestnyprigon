begin;

-- The later catalog search rewrite accidentally restored a reservation check
-- against the entire queue table. Use the released-reservation view so retired
-- discovery rows stay in history without suppressing a future fresh search.
do $$
declare
  definition text;
  old_filter text := 'from public.chestny_enrichment_queue q where q.source_listing_id = x.source_listing_id';
  new_filter text := 'from public.chestny_discovery_reserved_queue q where q.source_listing_id = x.source_listing_id';
begin
  definition := pg_get_functiondef(
    'public.record_chestny_catalog_search_page(uuid,text,uuid,integer,integer,integer,jsonb,boolean)'::regprocedure
  );
  if strpos(definition, old_filter) > 0 then
    execute replace(definition, old_filter, new_filter);
  elsif strpos(definition, new_filter) = 0 then
    raise exception 'Search reservation filter changed; inspect the deployed function before migrating';
  end if;
end;
$$;

-- Retire only an approved, discovery-only run after confirming no worker owns
-- it and no candidate is leased. Keep every queue row for audit/history.
create or replace function public.retire_chestny_discovery_run(
  p_run_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '60s'
as $$
declare
  run_row public.chestny_enrichment_runs;
  released_count integer;
begin
  if p_run_id is null or nullif(trim(p_reason), '') is null then
    raise exception 'run id and retirement reason are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_run_id::text, 1));
  select * into run_row from public.chestny_enrichment_runs where id = p_run_id for update;
  if not found then raise exception 'Discovery run was not found'; end if;
  if run_row.source_file <> 'local-catalog-launch-search'
    or run_row.rules->>'discoveryOnly' is distinct from 'true' then
    raise exception 'Only a local discovery-only run can be retired this way';
  end if;
  if run_row.status <> 'approved' then
    raise exception 'Discovery run must be approved, current status: %', run_row.status;
  end if;
  if exists (
    select 1 from public.chestny_enrichment_worker_lock
    where lock_name = 'chestny-catalog-enrichment'
      and run_id = p_run_id and expires_at > now()
  ) then
    raise exception 'A live worker lock is held for this discovery run';
  end if;
  if exists (select 1 from public.chestny_enrichment_queue where run_id = p_run_id and status = 'leased') then
    raise exception 'Discovery run still has leased candidates';
  end if;

  update public.chestny_enrichment_queue
  set status = 'cancelled', lease_until = null, updated_at = now(),
      discovery_release = jsonb_build_object(
        'reason', trim(p_reason), 'retiredRunId', p_run_id::text, 'releasedAt', now()
      )
  where run_id = p_run_id and status = 'queued' and discovery_release is null;
  get diagnostics released_count = row_count;

  update public.chestny_enrichment_runs
  set status = 'cancelled', completed_at = now()
  where id = p_run_id and status = 'approved';

  return jsonb_build_object(
    'runId', p_run_id,
    'status', 'cancelled',
    'releasedReservations', released_count,
    'historyPreserved', true
  );
end;
$$;

revoke all on function public.retire_chestny_discovery_run(uuid, text) from public, anon, authenticated;
grant execute on function public.retire_chestny_discovery_run(uuid, text) to service_role;

commit;
