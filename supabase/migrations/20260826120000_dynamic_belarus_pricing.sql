-- State payments are calculated in application code from current legal rules
-- and NBRB rates. The legacy EUR utilization field is retained only for
-- backwards-compatible schema reads and must not be used in calculations.
update public.pricing_profiles
set
  version = 'chestny-prigon-client-table-v2-dynamic-state-fees',
  utilization_fee_eur = 0
where id = 'belarus-default';

comment on column public.pricing_profiles.utilization_fee_eur is
  'Deprecated: Belarus utilization fee is calculated dynamically in BYN by vehicle age and import regime.';
