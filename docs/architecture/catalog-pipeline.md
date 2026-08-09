# Catalog data pipeline

The public catalog is isolated from source payloads and parser internals.

1. `import_runs` records each initial or incremental synchronization.
2. `encar_raw_listings` stores the original source payload privately.
3. `listing_screening` records the versioned eligibility decision.
4. Only approved listings are normalized into `vehicles` and marked public.
5. `catalog_vehicles` is the read model exposed to the website.

Publication is protected twice: row-level security only exposes active public rows, and the database trigger refuses to publish a vehicle until its screening row is approved with every exclusion flag clear.

## Remote project safety

This repository must only be linked to a newly created Supabase project for Chestny Prigon. Never link it to Autoexport or TMA. Before every remote migration, verify the linked reference with `supabase projects list` and preview changes with `supabase db push --dry-run`.

## Deployment sequence

1. Create the new remote project in the intended Supabase account and region.
2. Put its URL and publishable key in `.env.local`; keep the service role key server-only.
3. Run `supabase link --project-ref <new-project-ref>`.
4. Run `supabase db push --dry-run` and review the exact target and SQL.
5. Run `supabase db push` only after the target is confirmed.
