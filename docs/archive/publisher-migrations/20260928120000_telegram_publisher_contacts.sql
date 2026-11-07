create table if not exists public.telegram_publisher_contacts (
  id boolean primary key default true check (id),
  phone text not null default '+375 (44) 754-39-87',
  whatsapp text not null default 'https://wa.me/375447543987',
  email text not null default 'Chestnyjprigon@gmail.com',
  telegram text not null default 'https://t.me/IvanPrigon',
  updated_at timestamptz not null default now()
);

insert into public.telegram_publisher_contacts (id)
values (true)
on conflict (id) do nothing;

alter table public.telegram_publisher_contacts enable row level security;
revoke all on public.telegram_publisher_contacts from anon, authenticated;

alter table public.telegram_publish_sessions
  drop constraint if exists telegram_publish_sessions_state_check;

alter table public.telegram_publish_sessions
  add constraint telegram_publish_sessions_state_check
  check (state in ('waiting_for_vehicle_url', 'waiting_for_contact_value'));

alter table public.telegram_publish_sessions
  add column if not exists contact_key text
  check (contact_key is null or contact_key in ('phone', 'whatsapp', 'email', 'telegram'));
