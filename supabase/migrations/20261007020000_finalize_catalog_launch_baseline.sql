begin;

alter table public.chestny_catalog_launches alter column status set default 'capturing';
alter table public.chestny_catalog_launches drop constraint if exists chestny_catalog_launches_status_check;
alter table public.chestny_catalog_launches add constraint chestny_catalog_launches_status_check
  check(status in ('capturing','prepared','running','completed','cancelled'));

create or replace function public.finalize_chestny_catalog_baseline(p_launch uuid) returns void
language plpgsql security definer set search_path='' as $$
declare expected bigint; actual bigint;
begin
  if not exists(select 1 from public.chestny_catalog_launches where id=p_launch and status='capturing' for update) then
    raise exception 'Launch is not capturing';
  end if;
  select count(*) into expected from public.vehicles where source_listing_id is not null;
  select count(distinct source_identifier) into actual
    from public.chestny_catalog_launch_baseline_identifiers where launch_id=p_launch;
  if actual<expected then
    raise exception 'Launch baseline is incomplete: captured %, vehicle IDs %',actual,expected;
  end if;
  update public.chestny_catalog_launches set status='prepared' where id=p_launch;
end; $$;
revoke all on function public.finalize_chestny_catalog_baseline(uuid) from public,anon,authenticated;
grant execute on function public.finalize_chestny_catalog_baseline(uuid) to service_role;

notify pgrst, 'reload schema';
commit;
