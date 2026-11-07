select cron.schedule(
  'publisher-posts-every-minute',
  '* * * * *',
  'select public.trigger_publisher_schedule()'
);
