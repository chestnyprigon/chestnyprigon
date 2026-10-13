create table if not exists public.control_center_tasks (
  id uuid primary key default extensions.gen_random_uuid(),
  module_id text not null,
  product text not null,
  source text not null,
  goal text not null check (length(trim(goal)) > 0),
  parameters jsonb not null default '{}'::jsonb check (jsonb_typeof(parameters) = 'object'),
  state text not null default 'queued' check (state in ('queued','preparing','ready','running','paused','completed','failed','cancelled')),
  progress jsonb not null default '{}'::jsonb check (jsonb_typeof(progress) = 'object'),
  result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  external_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists control_center_tasks_product_state_idx
  on public.control_center_tasks(product, state, updated_at desc);
create index if not exists control_center_tasks_module_state_idx
  on public.control_center_tasks(module_id, state, updated_at desc);
create unique index if not exists control_center_tasks_external_ref_idx
  on public.control_center_tasks(module_id, external_ref) where external_ref is not null;

alter table public.control_center_tasks enable row level security;
revoke all on public.control_center_tasks from anon, authenticated;
grant select, insert, update on public.control_center_tasks to service_role;
