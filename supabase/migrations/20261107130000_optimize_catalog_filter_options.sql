-- Keep dependent filter lookups on the existing partial index. A shared CTE
-- materialized every public listing before each distinct-values lookup.
create or replace function public.get_catalog_filter_options(
  p_brand text default null,
  p_model text default null
)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  normalized_brand text := nullif(btrim(p_brand), '');
  normalized_model text := nullif(btrim(p_model), '');
  options jsonb;
begin
  if normalized_brand is null then
    select jsonb_build_object(
      'brands', coalesce(jsonb_agg(manufacturer order by manufacturer), '[]'::jsonb),
      'models', '[]'::jsonb,
      'trims', '[]'::jsonb
    )
    into options
    from (
      select distinct manufacturer
      from public.vehicles
      where is_public = true
        and status = 'active'
        and price_usd is not null
        and fuel_type not in ('전기', '수소')
        and nullif(btrim(manufacturer), '') is not null
    ) brands;
  elsif normalized_model is null then
    select jsonb_build_object(
      'brands', '[]'::jsonb,
      'models', coalesce(jsonb_agg(model order by model), '[]'::jsonb),
      'trims', '[]'::jsonb
    )
    into options
    from (
      select distinct model
      from public.vehicles
      where is_public = true
        and status = 'active'
        and price_usd is not null
        and fuel_type not in ('전기', '수소')
        and manufacturer = normalized_brand
        and nullif(btrim(model), '') is not null
    ) models;
  else
    select jsonb_build_object(
      'brands', '[]'::jsonb,
      'models', '[]'::jsonb,
      'trims', coalesce(jsonb_agg(trim order by trim), '[]'::jsonb)
    )
    into options
    from (
      select distinct trim
      from public.vehicles
      where is_public = true
        and status = 'active'
        and price_usd is not null
        and fuel_type not in ('전기', '수소')
        and manufacturer = normalized_brand
        and model = normalized_model
        and nullif(btrim(trim), '') is not null
    ) trims;
  end if;

  return options;
end;
$$;

grant execute on function public.get_catalog_filter_options(text, text) to anon, authenticated;
