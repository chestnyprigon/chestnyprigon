create table if not exists public.lead_comments (
  id bigint generated always as identity primary key,
  lead_id uuid not null references public.leads(id) on delete cascade,
  author_name text not null default 'Администратор',
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists lead_comments_lead_id_created_at_idx on public.lead_comments(lead_id, created_at);
alter table public.lead_comments enable row level security;
revoke all on public.lead_comments from anon, authenticated;
