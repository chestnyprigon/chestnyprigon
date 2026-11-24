alter table public.mobile_de_catalog_listings
  add constraint mobile_de_public_listings_exclude_pure_electric
  check (
    not catalog_visible
    or upper(btrim(coalesce(fuel_type, ''))) not in (
      'ELECTRIC', 'ELEKTRO', 'ЭЛЕКТРО', 'ЭЛЕКТРИЧЕСКИЙ', 'ЭЛЕКТРОМОБИЛЬ',
      'EV', 'BEV', 'BATTERY ELECTRIC', '전기'
    )
  ) not valid;

update public.mobile_de_catalog_listings
set catalog_visible = false,
    updated_at = now()
where catalog_visible
  and upper(btrim(coalesce(fuel_type, ''))) in (
    'ELECTRIC', 'ELEKTRO', 'ЭЛЕКТРО', 'ЭЛЕКТРИЧЕСКИЙ', 'ЭЛЕКТРОМОБИЛЬ',
    'EV', 'BEV', 'BATTERY ELECTRIC', '전기'
  );

alter table public.mobile_de_catalog_listings
  validate constraint mobile_de_public_listings_exclude_pure_electric;
