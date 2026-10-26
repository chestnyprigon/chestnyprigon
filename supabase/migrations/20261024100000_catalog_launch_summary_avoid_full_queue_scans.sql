begin;

-- Launch creation is followed by an exact, paginated baseline identifier
-- snapshot in the local launcher. Avoid full-table queue/staging aggregates
-- here: they made the initial RPC exceed the hosted statement timeout.
create or replace function public.prepare_chestny_catalog_launch(
  p_name text,
  p_quotas jsonb,
  p_rules jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
set statement_timeout = '30s'
as $$
declare
  v_id uuid;
  v_counts jsonb;
  v_brand_count integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_name));
  select id into v_id from public.chestny_catalog_launches where name = p_name;
  if v_id is not null then
    if exists (select 1 from public.chestny_catalog_launches where id = v_id and status <> 'prepared') then
      raise exception 'Launch baseline capture is incomplete';
    end if;
    insert into public.chestny_catalog_brand_search_progress(launch_id, manufacturer)
      select v_id, manufacturer from public.chestny_catalog_launch_quotas where launch_id = v_id
      on conflict (launch_id, manufacturer) do nothing;
    return v_id;
  end if;

  if jsonb_typeof(p_quotas) <> 'array' or jsonb_array_length(p_quotas) = 0 then
    raise exception 'Brand diversity guidance must contain at least one brand';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_quotas) as q(manufacturer text, target integer)
    where coalesce(trim(q.manufacturer), '') = '' or q.target is null or q.target <= 0
  ) then raise exception 'Brand guidance requires a name and a positive integer weight'; end if;
  select count(distinct q.manufacturer) into v_brand_count
    from jsonb_to_recordset(p_quotas) as q(manufacturer text, target integer);
  if v_brand_count <> jsonb_array_length(p_quotas) then
    raise exception 'Brand diversity guidance must not contain duplicate brands';
  end if;

  select jsonb_build_object(
    'publicActive', (select count(*) from public.vehicles where is_public and status = 'active'),
    'publicByBrand', (select jsonb_object_agg(manufacturer, n) from
      (select manufacturer, count(*) n from public.vehicles where is_public and status = 'active' group by manufacturer) b),
    'queue', '{}'::jsonb,
    'staging', '{}'::jsonb,
    'queueAndStagingSummary', 'omitted to avoid full-table scans; exact known identifiers are captured separately',
    'newPublicationsRule', 'Unique canonical IDs absent from the captured baseline, attached to this launch, and passing all publication gates; brand targets are diversity guidance only; no overall or per-brand publication cap'
  ) into v_counts;

  insert into public.chestny_catalog_launches(name, rules, baseline_counts)
    values (p_name, coalesce(p_rules, '{}'::jsonb), v_counts) returning id into v_id;
  insert into public.chestny_catalog_launch_quotas(launch_id, manufacturer, target, baseline_public_count)
    select v_id, q.manufacturer, q.target,
      coalesce((v_counts->'publicByBrand'->>q.manufacturer)::integer, 0)
    from jsonb_to_recordset(p_quotas) as q(manufacturer text, target integer);
  insert into public.chestny_catalog_brand_search_progress(launch_id, manufacturer)
    select v_id, manufacturer from public.chestny_catalog_launch_quotas where launch_id = v_id
    on conflict (launch_id, manufacturer) do nothing;
  return v_id;
end;
$$;

revoke all on function public.prepare_chestny_catalog_launch(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.prepare_chestny_catalog_launch(text, jsonb, jsonb) to service_role;

commit;
