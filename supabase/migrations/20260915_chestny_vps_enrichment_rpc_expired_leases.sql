-- Reclaim abandoned leases after a worker interruption. Active leases remain
-- protected until their lease_until timestamp has passed.
create or replace function public.claim_chestny_enrichment_queue(
  p_run_id uuid,
  p_limit integer,
  p_lease_minutes integer
)
returns setof public.chestny_enrichment_queue
language sql
security definer
set search_path = public
as $$
  with picked as (
    select id
    from public.chestny_enrichment_queue
    where run_id = p_run_id
      and status in ('queued', 'leased')
      and (status = 'queued' or lease_until is null or lease_until < now())
    order by created_at
    for update skip locked
    limit greatest(1, least(p_limit, 50))
  )
  update public.chestny_enrichment_queue q
  set status = 'leased',
      lease_until = now() + make_interval(mins => greatest(5, least(p_lease_minutes, 120))),
      last_attempt_at = now(),
      attempt_count = q.attempt_count + 1,
      updated_at = now()
  from picked
  where q.id = picked.id
  returning q.*;
$$;

grant execute on function public.claim_chestny_enrichment_queue(uuid, integer, integer) to service_role;
