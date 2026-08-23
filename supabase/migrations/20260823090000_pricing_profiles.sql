create table public.pricing_profiles (
  id text primary key,
  version text not null,
  krw_per_usd numeric(12,4) not null check (krw_per_usd > 0),
  delivery_usd numeric(12,2) not null check (delivery_usd >= 0),
  commission_rate numeric(8,6) not null check (commission_rate >= 0 and commission_rate <= 1),
  svh_declarant_eur numeric(12,2) not null check (svh_declarant_eur >= 0),
  customs_clearance_eur numeric(12,2) not null check (customs_clearance_eur >= 0),
  utilization_fee_eur numeric(12,2) not null check (utilization_fee_eur >= 0),
  company_service_usd numeric(12,2) not null check (company_service_usd >= 0),
  updated_at timestamptz not null default now()
);

create table public.pricing_exchange_rates (
  id text primary key,
  rate_date date not null,
  usd_byn numeric(16,6) not null check (usd_byn > 0),
  eur_byn numeric(16,6) not null check (eur_byn > 0),
  source_url text not null,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger pricing_profiles_set_updated_at before update on public.pricing_profiles for each row execute function public.set_updated_at();
create trigger pricing_exchange_rates_set_updated_at before update on public.pricing_exchange_rates for each row execute function public.set_updated_at();

insert into public.pricing_profiles (id, version, krw_per_usd, delivery_usd, commission_rate, svh_declarant_eur, customs_clearance_eur, utilization_fee_eur, company_service_usd)
values ('belarus-default', 'chestny-prigon-client-table-v1', 1397, 4700, 0.025, 150, 400, 37, 300);

alter table public.pricing_profiles enable row level security;
alter table public.pricing_exchange_rates enable row level security;
revoke all on public.pricing_profiles from anon, authenticated;
revoke all on public.pricing_exchange_rates from anon, authenticated;

comment on table public.pricing_profiles is 'Commercial tariff profile for Chestny Prigon. Server-only; changes are made by authorized support.';
comment on table public.pricing_exchange_rates is 'Daily official NBRB exchange-rate cache used for Belarus customs conversions.';
