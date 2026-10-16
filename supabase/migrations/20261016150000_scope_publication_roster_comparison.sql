-- Scope both sides of the roster comparison before the FULL JOIN.
-- Rows owned by another manifest must not be treated as missing input rows.
begin;

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
      full join (
        select source_listing_id, position, canonical_id, manufacturer
        from public.chestny_catalog_publication_manifest_items
        where manifest_id = v_manifest_id
      ) i on i.source_listing_id = x.source_listing_id
      where x.source_listing_id is null or i.source_listing_id is null
        or i.position <> x.position or i.canonical_id <> x.canonical_id or i.manufacturer <> x.manufacturer
    ) then
    raise exception 'Existing publication manifest roster does not match the requested cohort';
  end if;
  return v_manifest_id;
end;
$$;

revoke all on function public.register_chestny_catalog_publication_manifest(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.register_chestny_catalog_publication_manifest(uuid, text, text, jsonb) to service_role;

commit;
