-- One global lock prevents catalog enrichment workers on different hosts from
-- claiming different runs at the same time. Expired leases recover after crash.
create table if not exists public.chestny_enrichment_worker_lock (
  lock_name text primary key check (lock_name = 'chestny-catalog-enrichment'),
  owner_token uuid not null,
  owner_host text not null,
  run_id uuid not null references public.chestny_enrichment_runs(id),
  heartbeat_at timestamptz not null,
  expires_at timestamptz not null
);

alter table public.chestny_enrichment_worker_lock enable row level security;
revoke all on public.chestny_enrichment_worker_lock from anon, authenticated;
grant select, insert, update, delete on public.chestny_enrichment_worker_lock to service_role;

create or replace function public.acquire_chestny_enrichment_worker_lock(
  p_token uuid, p_run_id uuid, p_host text, p_lease_seconds integer default 120
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_rows integer;
begin
  if p_token is null or p_run_id is null or nullif(trim(p_host), '') is null then
    raise exception 'worker lock token, run and host are required';
  end if;
  insert into public.chestny_enrichment_worker_lock(lock_name, owner_token, owner_host, run_id, heartbeat_at, expires_at)
  values ('chestny-catalog-enrichment', p_token, p_host, p_run_id, now(), now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 120), 600))))
  on conflict (lock_name) do update set
    owner_token = excluded.owner_token,
    owner_host = excluded.owner_host,
    run_id = excluded.run_id,
    heartbeat_at = now(),
    expires_at = excluded.expires_at
  where public.chestny_enrichment_worker_lock.owner_token = excluded.owner_token
     or public.chestny_enrichment_worker_lock.expires_at < now();
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

create or replace function public.release_chestny_enrichment_worker_lock(p_token uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_rows integer;
begin
  delete from public.chestny_enrichment_worker_lock
  where lock_name = 'chestny-catalog-enrichment' and owner_token = p_token;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.acquire_chestny_enrichment_worker_lock(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.release_chestny_enrichment_worker_lock(uuid) from public, anon, authenticated;
grant execute on function public.acquire_chestny_enrichment_worker_lock(uuid, uuid, text, integer) to service_role;
grant execute on function public.release_chestny_enrichment_worker_lock(uuid) to service_role;
