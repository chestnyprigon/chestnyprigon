-- A report retry must never downgrade a successfully saved vehicle payload.
-- The vehicle/detail outcome and the insurance-report outcome are independent.

alter table public.chestny_catalog_staging
  add column if not exists report_classification text,
  add column if not exists report_checked_at timestamptz,
  add column if not exists report_retry_detail jsonb not null default '{}'::jsonb;

-- Preserve the original detail/gallery outcome for every row that has a saved
-- Encar payload. Historical retry runs used the generic completion RPC and
-- accidentally changed these rows to enrichment_status=unavailable.
update public.chestny_catalog_staging
set enrichment_status = 'succeeded'
where encar_payload is not null
  and encar_payload <> '{}'::jsonb;

-- Backfill the latest known retry classification without changing report_status
-- for transient technical failures.
with latest_retry as (
  select distinct on (queue.source_listing_id)
    queue.source_listing_id,
    queue.result,
    coalesce(queue.completed_at, queue.updated_at) as checked_at
  from public.chestny_enrichment_queue queue
  join public.chestny_enrichment_runs run on run.id = queue.run_id
  where run.rules ->> 'type' = 'report_retry'
    and queue.result ? 'classification'
  order by queue.source_listing_id, coalesce(queue.completed_at, queue.updated_at) desc
)
update public.chestny_catalog_staging staging
set report_classification = latest_retry.result ->> 'classification',
    report_checked_at = latest_retry.checked_at,
    report_retry_detail = latest_retry.result,
    report_status = case
      when latest_retry.result ->> 'classification' = 'ready' then 'ready'
      when latest_retry.result ->> 'classification' = 'report_not_found' then 'unavailable'
      else staging.report_status
    end
from latest_retry
where staging.source_listing_id = latest_retry.source_listing_id;

create or replace function public.complete_chestny_report_retry_item(
  p_queue_id uuid,
  p_queue_status text,
  p_result jsonb,
  p_inspection jsonb default null,
  p_summary jsonb default null,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_id text;
  v_classification text;
begin
  if p_queue_status not in ('succeeded', 'failed') then
    raise exception 'unsupported retry queue status %', p_queue_status;
  end if;

  select source_listing_id into v_source_id
  from public.chestny_enrichment_queue
  where id = p_queue_id
  for update;

  if v_source_id is null then
    raise exception 'queue item not found';
  end if;

  v_classification := nullif(p_result ->> 'classification', '');

  -- Do not overwrite encar_payload or image_urls: this worker only retries
  -- inspection endpoints, not detail/gallery retrieval.
  update public.chestny_catalog_staging
  set enrichment_status = case
        when encar_payload is not null and encar_payload <> '{}'::jsonb then 'succeeded'
        else enrichment_status
      end,
      report_status = case
        when v_classification = 'ready' then 'ready'
        when v_classification = 'report_not_found' then 'unavailable'
        else report_status
      end,
      report_classification = v_classification,
      report_checked_at = now(),
      report_retry_detail = jsonb_strip_nulls(jsonb_build_object(
        'result', p_result,
        'inspection', p_inspection,
        'summary', p_summary
      )),
      updated_at = now()
  where source_listing_id = v_source_id;

  update public.chestny_enrichment_queue
  set status = p_queue_status,
      result = p_result,
      lease_until = null,
      completed_at = case when p_queue_status = 'succeeded' then now() else null end,
      last_error = case when p_queue_status = 'failed' then p_error else null end,
      updated_at = now()
  where id = p_queue_id;
end;
$$;

grant execute on function public.complete_chestny_report_retry_item(uuid, text, jsonb, jsonb, jsonb, text) to service_role;
