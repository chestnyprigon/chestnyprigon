create table public.chestny_catalog_worker_commands (
  id uuid primary key default extensions.gen_random_uuid(),
  telegram_update_id bigint not null unique,
  telegram_user_id bigint not null,
  telegram_chat_id bigint not null,
  command text not null check (command in ('start','pause','stop','resume')),
  run_id uuid not null references public.chestny_enrichment_runs(id),
  max_items integer not null default 50 check (max_items between 1 and 50),
  status text not null default 'pending' check (status in ('pending','processing','completed','failed')),
  requested_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  attempt_count integer not null default 0,
  finished_at timestamptz,
  result jsonb,
  error text
);

create index chestny_catalog_worker_commands_pending_idx
  on public.chestny_catalog_worker_commands(status, requested_at);

alter table public.chestny_catalog_worker_commands enable row level security;
revoke all on public.chestny_catalog_worker_commands from anon, authenticated;
grant select, insert, update on public.chestny_catalog_worker_commands to service_role;

create or replace function public.claim_chestny_catalog_worker_command(
  p_token uuid,
  p_lease_seconds integer default 90
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare item public.chestny_catalog_worker_commands;
begin
  if p_token is null then raise exception 'command lease token is required'; end if;
  with candidate as (
    select id from public.chestny_catalog_worker_commands
    where status = 'pending' or (status = 'processing' and lease_until < now())
    order by requested_at
    for update skip locked
    limit 1
  )
  update public.chestny_catalog_worker_commands c
  set status = 'processing', lease_token = p_token,
      lease_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds,90),300))),
      attempt_count = attempt_count + 1
  from candidate where c.id = candidate.id
  returning c.* into item;
  return case when item.id is null then null else to_jsonb(item) end;
end;
$$;

create or replace function public.finish_chestny_catalog_worker_command(
  p_id uuid,
  p_token uuid,
  p_result jsonb default null,
  p_error text default null
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare changed integer;
begin
  update public.chestny_catalog_worker_commands
  set status = case when p_error is null then 'completed' else 'failed' end,
      result = p_result, error = left(p_error, 1000), finished_at = now(),
      lease_token = null, lease_until = null
  where id = p_id and status = 'processing' and lease_token = p_token;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

revoke all on function public.claim_chestny_catalog_worker_command(uuid, integer) from public, anon, authenticated;
revoke all on function public.finish_chestny_catalog_worker_command(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.claim_chestny_catalog_worker_command(uuid, integer) to service_role;
grant execute on function public.finish_chestny_catalog_worker_command(uuid, uuid, jsonb, text) to service_role;
