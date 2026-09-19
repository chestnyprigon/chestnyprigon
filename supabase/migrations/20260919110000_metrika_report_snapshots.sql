create table if not exists public.metrika_report_snapshots (
  id bigint generated always as identity primary key,
  report_key text not null,
  period_start date not null,
  period_end date not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  unique (report_key, period_start, period_end)
);

alter table public.metrika_report_snapshots enable row level security;
revoke all on public.metrika_report_snapshots from anon, authenticated;
