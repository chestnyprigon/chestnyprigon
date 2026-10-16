begin;

create or replace function public.prepare_chestny_catalog_launch(
  p_name text,
  p_quotas jsonb,
  p_rules jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_counts jsonb;
  v_total integer;
  v_brands integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_name));

  select id into v_id
  from public.chestny_catalog_launches
  where name = p_name;

  if v_id is not null then
    if exists (
      select 1 from public.chestny_catalog_launches
      where id = v_id and status <> 'prepared'
    ) then
      raise exception 'Launch baseline capture is incomplete';
    end if;

    -- Repair older prepared launches too; the primary key makes this idempotent.
    insert into public.chestny_catalog_brand_search_progress(launch_id, manufacturer)
    select v_id, manufacturer
    from public.chestny_catalog_launch_quotas
    where launch_id = v_id
    on conflict (launch_id, manufacturer) do nothing;

    return v_id;
  end if;

  select sum((value->>'target')::integer),
         count(distinct value->>'manufacturer')
  into v_total, v_brands
  from jsonb_array_elements(p_quotas);

  if v_total <> 1000 or v_brands <> jsonb_array_length(p_quotas) then
    raise exception 'Launch requires unique brand quotas summing to 1000';
  end if;

  select jsonb_build_object(
    'publicActive', (select count(*) from public.vehicles where is_public and status = 'active'),
    'publicByBrand', (
      select jsonb_object_agg(manufacturer, n)
      from (select manufacturer, count(*) n from public.vehicles where is_public and status = 'active' group by manufacturer) b
    ),
    'queue', (select jsonb_object_agg(status, n) from (select status, count(*) n from public.chestny_enrichment_queue group by status) q),
    'staging', (select jsonb_object_agg(enrichment_status, n) from (select enrichment_status, count(*) n from public.chestny_catalog_staging group by enrichment_status) s),
    'newPublicationsRule', 'Unique canonical IDs not known before baseline, explicitly attached to this launch, approved and still public; re-publication does not create a second credit; inactive credits do not count towards 1000'
  ) into v_counts;

  insert into public.chestny_catalog_launches(name, rules, baseline_counts)
  values (p_name, p_rules, v_counts)
  returning id into v_id;

  insert into public.chestny_catalog_launch_quotas(launch_id, manufacturer, target, baseline_public_count)
  select v_id,
         value->>'manufacturer',
         (value->>'target')::integer,
         coalesce((v_counts->'publicByBrand'->>(value->>'manufacturer'))::integer, 0)
  from jsonb_array_elements(p_quotas);

  insert into public.chestny_catalog_brand_search_progress(launch_id, manufacturer)
  select v_id, manufacturer
  from public.chestny_catalog_launch_quotas
  where launch_id = v_id
  on conflict (launch_id, manufacturer) do nothing;

  return v_id;
end;
$$;

revoke all on function public.prepare_chestny_catalog_launch(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.prepare_chestny_catalog_launch(text, jsonb, jsonb) to service_role;

commit;
