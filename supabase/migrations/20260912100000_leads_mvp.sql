create extension if not exists pgcrypto;

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  public_number bigint generated always as identity unique,
  name text not null,
  phone text not null,
  email text,
  telegram_username text,
  message text,
  source text not null default 'website',
  page_url text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  status text not null default 'new' check (status in ('new', 'in_progress', 'contacted', 'quote_sent', 'waiting', 'won', 'lost')),
  assigned_to uuid,
  notification_status text not null default 'pending' check (notification_status in ('pending', 'sent', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lead_vehicle_context (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  vehicle_snapshot jsonb,
  calculation_snapshot jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.lead_status_history (
  id bigint generated always as identity primary key,
  lead_id uuid not null references public.leads(id) on delete cascade,
  from_status text,
  to_status text not null,
  changed_by uuid,
  comment text,
  created_at timestamptz not null default now()
);

create index if not exists leads_status_created_at_idx on public.leads(status, created_at desc);
create index if not exists leads_source_created_at_idx on public.leads(source, created_at desc);

alter table public.leads enable row level security;
alter table public.lead_vehicle_context enable row level security;
alter table public.lead_status_history enable row level security;

revoke all on public.leads from anon, authenticated;
revoke all on public.lead_vehicle_context from anon, authenticated;
revoke all on public.lead_status_history from anon, authenticated;

