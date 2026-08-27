-- Client-approved commercial tariff update: delivery to Minsk and Korean-side commission.
-- State payments remain dynamic in the application and are not changed here.
update public.pricing_profiles
set
  version = 'chestny-prigon-client-table-v3-preferential-default',
  delivery_usd = 4900,
  commission_rate = 0.02
where id = 'belarus-default';
