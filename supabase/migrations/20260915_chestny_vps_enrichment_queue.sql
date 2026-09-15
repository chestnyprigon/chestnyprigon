create table if not exists public.chestny_enrichment_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  project text not null default 'chestny-prigon',
  status text not null default 'awaiting_approval' check (status in ('awaiting_approval','approved','running','completed','cancelled')),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  source_file text not null,
  rules jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.chestny_enrichment_queue (
  id uuid primary key default extensions.gen_random_uuid(),
  run_id uuid not null references public.chestny_enrichment_runs(id) on delete cascade,
  source_listing_id text not null,
  source_url text,
  candidate_snapshot jsonb not null,
  status text not null default 'queued' check (status in ('queued','leased','succeeded','unavailable','failed','cancelled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_until timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  result jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, source_listing_id)
);

create table if not exists public.chestny_catalog_staging (
  source_listing_id text primary key,
  source_url text,
  candidate_snapshot jsonb not null default '{}'::jsonb,
  encar_payload jsonb,
  image_urls jsonb not null default '[]'::jsonb,
  fuel_type text,
  exterior_color text,
  report_status text check (report_status in ('ready','unavailable')),
  enrichment_status text not null default 'pending' check (enrichment_status in ('pending','succeeded','unavailable','failed')),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists chestny_enrichment_queue_run_status_idx
  on public.chestny_enrichment_queue (run_id, status, created_at);

alter table public.chestny_enrichment_runs enable row level security;
alter table public.chestny_enrichment_queue enable row level security;
alter table public.chestny_catalog_staging enable row level security;

revoke all on public.chestny_enrichment_runs from anon, authenticated;
revoke all on public.chestny_enrichment_queue from anon, authenticated;
revoke all on public.chestny_catalog_staging from anon, authenticated;
