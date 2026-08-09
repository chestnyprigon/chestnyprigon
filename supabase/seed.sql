insert into public.import_runs (id, mode, status, finished_at, fetched_count, accepted_count)
values ('00000000-0000-0000-0000-000000000001', 'initial', 'completed', now(), 3, 3);

insert into public.encar_raw_listings (source_listing_id, import_run_id, source_url, payload, payload_hash, processed_at)
values
  ('demo-genesis-gv70', '00000000-0000-0000-0000-000000000001', 'https://www.encar.com/', '{"demo":true}'::jsonb, 'demo-genesis-gv70-v1', now()),
  ('demo-kia-sorento', '00000000-0000-0000-0000-000000000001', 'https://www.encar.com/', '{"demo":true}'::jsonb, 'demo-kia-sorento-v1', now()),
  ('demo-hyundai-palisade', '00000000-0000-0000-0000-000000000001', 'https://www.encar.com/', '{"demo":true}'::jsonb, 'demo-hyundai-palisade-v1', now());

insert into public.listing_screening (source_listing_id, decision, rules_version)
values
  ('demo-genesis-gv70', 'approved', 'demo-v1'),
  ('demo-kia-sorento', 'approved', 'demo-v1'),
  ('demo-hyundai-palisade', 'approved', 'demo-v1');

insert into public.vehicles (id, source_listing_id, manufacturer, model, trim, model_year, mileage_km, price_krw, price_usd, engine_cc, fuel_type, drive_type, location, status, is_public, source_url)
values
  ('10000000-0000-0000-0000-000000000001', 'demo-genesis-gv70', 'Genesis', 'GV70', '2.5T AWD', 2023, 28400, 44700000, 32900, 2497, 'gasoline', 'AWD', 'Seoul', 'active', true, 'https://www.encar.com/'),
  ('10000000-0000-0000-0000-000000000002', 'demo-kia-sorento', 'Kia', 'Sorento', 'Signature', 2022, 41200, 33600000, 24700, 2151, 'diesel', 'AWD', 'Incheon', 'active', true, 'https://www.encar.com/'),
  ('10000000-0000-0000-0000-000000000003', 'demo-hyundai-palisade', 'Hyundai', 'Palisade', 'Calligraphy', 2024, 16850, 56200000, 41300, 2497, 'gasoline', 'AWD', 'Suwon', 'active', true, 'https://www.encar.com/');

insert into public.vehicle_images (vehicle_id, source_url, position)
values
  ('10000000-0000-0000-0000-000000000001', '/assets/catalog/genesis.svg', 0),
  ('10000000-0000-0000-0000-000000000002', '/assets/catalog/kia.svg', 0),
  ('10000000-0000-0000-0000-000000000003', '/assets/catalog/hyundai.svg', 0);
