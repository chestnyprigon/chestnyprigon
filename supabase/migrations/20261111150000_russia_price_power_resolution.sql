alter table public.russia_price_snapshots
  add column power_resolution jsonb
    check (power_resolution is null or jsonb_typeof(power_resolution) = 'object');

comment on column public.russia_price_snapshots.power_resolution is
  'Versioned power resolution cache bound to the listing power-input fingerprint. Reused for price refreshes until power-relevant listing data changes.';
