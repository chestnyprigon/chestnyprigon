-- Fast, bounded source for the dependent catalogue filters. The old HTTP
-- route read every public vehicle in 1,000-row pages for each filter change.
create index if not exists vehicles_public_filter_options_idx
  on public.vehicles (manufacturer, model, trim)
  where is_public = true
    and status = 'active'
    and price_usd is not null
    and fuel_type not in ('전기', '수소');

create or replace function public.get_catalog_filter_options(
  p_brand text default null,
  p_model text default null
)
returns jsonb
language sql
stable
set search_path = public
as $$
  with visible as (
    select manufacturer, model, trim
    from public.vehicles
    where is_public = true
      and status = 'active'
      and price_usd is not null
      and fuel_type not in ('전기', '수소')
  )
  select jsonb_build_object(
    'brands', case when nullif(btrim(p_brand), '') is null then coalesce((
      select jsonb_agg(manufacturer order by manufacturer)
      from (select distinct manufacturer from visible where nullif(btrim(manufacturer), '') is not null) brands
    ), '[]'::jsonb) else '[]'::jsonb end,
    'models', case when nullif(btrim(p_brand), '') is not null and nullif(btrim(p_model), '') is null then coalesce((
      select jsonb_agg(model order by model)
      from (select distinct model from visible where manufacturer = p_brand and nullif(btrim(model), '') is not null) models
    ), '[]'::jsonb) else '[]'::jsonb end,
    'trims', case when nullif(btrim(p_brand), '') is not null and nullif(btrim(p_model), '') is not null then coalesce((
      select jsonb_agg(trim order by trim)
      from (select distinct trim from visible where manufacturer = p_brand and model = p_model and nullif(btrim(trim), '') is not null) trims
    ), '[]'::jsonb) else '[]'::jsonb end
  );
$$;

grant execute on function public.get_catalog_filter_options(text, text) to anon, authenticated;
