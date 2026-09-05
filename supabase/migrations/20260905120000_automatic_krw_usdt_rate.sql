create table public.pricing_krw_usdt_rates (
  id text primary key,
  raw_krw_per_usdt numeric(12,4) not null check (raw_krw_per_usdt between 1000 and 2000),
  adjustment_krw numeric(12,4) not null,
  effective_krw_per_usd numeric(12,4) not null check (effective_krw_per_usd > 0),
  source_url text not null,
  source_as_of timestamptz,
  fetched_at timestamptz not null,
  updated_at timestamptz not null default now(),
  check (effective_krw_per_usd = raw_krw_per_usdt + adjustment_krw)
);

create trigger pricing_krw_usdt_rates_set_updated_at
before update on public.pricing_krw_usdt_rates
for each row execute function public.set_updated_at();

alter table public.pricing_krw_usdt_rates enable row level security;
revoke all on public.pricing_krw_usdt_rates from anon, authenticated;

comment on table public.pricing_krw_usdt_rates is
  'Cached Bithumb USDT/KRW commercial rate from Naver. Effective KRW/USD equals raw rate plus the approved correction.';
