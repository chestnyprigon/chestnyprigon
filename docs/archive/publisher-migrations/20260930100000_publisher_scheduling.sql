alter table public.telegram_publish_sessions
  drop constraint if exists telegram_publish_sessions_state_check;

alter table public.telegram_publish_sessions
  add constraint telegram_publish_sessions_state_check
  check (state in ('waiting_for_vehicle_url', 'waiting_for_contact_value', 'waiting_for_schedule_date'));

alter table public.telegram_publish_sessions
  add column if not exists draft_id uuid references public.telegram_posts(id) on delete set null;

alter table public.telegram_posts
  add column if not exists attempt_count integer not null default 0;

alter table public.telegram_posts
  add column if not exists created_by_name text;

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create or replace function public.trigger_publisher_schedule()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  scheduler_secret text;
begin
  select decrypted_secret into scheduler_secret
  from vault.decrypted_secrets
  where name = 'publisher_cron_secret'
  limit 1;

  if scheduler_secret is null then
    raise exception 'Publisher scheduler secret is not configured in Vault';
  end if;

  perform net.http_post(
    url := 'https://chestny-prigon-publisher.vercel.app/api/cron/publish',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || scheduler_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

revoke all on function public.trigger_publisher_schedule() from public, anon, authenticated;
