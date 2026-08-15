# Catalog data pipeline

The public catalog is isolated from source payloads and parser internals.

1. `import_runs` records each initial or incremental synchronization.
2. `encar_raw_listings` stores the original source payload privately.
3. `listing_screening` records the versioned eligibility decision.
4. Only approved listings are normalized into `vehicles` and marked public.
5. `vehicle_reports` stores a public-safe summary of Encar options, inspection and accident reports.
6. `catalog_vehicles` is the read model exposed to the website.

Publication is protected twice: row-level security only exposes active public rows, and the database trigger refuses to publish a vehicle until its screening row is approved with every exclusion flag clear.

## Encar pilot commands

The parser is dry-run by default and is capped at 100 rows:

```bash
npm run encar:pilot -- --limit=20
```

Write a screened batch to private raw/normalized tables without exposing it on the website:

```bash
npm run encar:pilot -- --offset=40 --limit=60 --write
```

`--offset` selects the next search window so expansion does not intentionally reread the first page. `--publish` is intentionally separate and requires `--write`. It must not be used until the normalized fields, calculator inputs and catalog card are approved. Search advertisements are deduplicated by Encar's canonical vehicle ID; the current advertisement ID remains in the private payload and source URL. Re-seen vehicles keep their existing calculated price and publication state until the dedicated pricing and report stages run.

## Encar report enrichment

After a controlled write, request the canonical Encar options, inspection and accident endpoints and store only the safe display summary:

```bash
npm run encar:enrich -- --apply-screening
```

For a resumable scale run, collect private rows first and then enrich only vehicles that do not yet have a canonical report:

```bash
npm run encar:scale -- --target=1000
npm run pricing:recalculate
npm run encar:enrich -- --only-missing --limit=2000 --apply-screening --publish-eligible
```

If a moving Encar search window is exhausted mostly by canonical duplicates, resume from an explicitly verified later window with `--search-offset=<offset>`. Stored canonical IDs remain deduplicated, so this does not create duplicate public cards.

`--apply-screening` removes from public visibility any vehicle whose inspection report confirms rental, taxi or commercial use. A reported accident remains visible as factual Encar history: the public card displays available insurance events, payment amounts and body repair/replacement findings. License plates, raw VIN values and source report payloads never enter the public read model.

Screening rule set `2026-08-12.1-report-disclosure` uses structured identity and usage fields plus rental plate markers. Free-form seller descriptions are not a hard exclusion source because they frequently advertise finance/lease options or contain phrases such as “no rental/taxi history.” Accident and repair evidence is retained for disclosure instead of being classified as problematic.

## Remote project safety

This repository must only be linked to a newly created Supabase project for Chestny Prigon. Never link it to Autoexport or TMA. Before every remote migration, verify the linked reference with `supabase projects list` and preview changes with `supabase db push --dry-run`.

Current production target: `chestny_prigon` (`ojnybjomttolhsfgkdqq`). The project ref is not a secret; credentials remain exclusively in `.env.local` and Supabase CLI secure storage.

## Deployment sequence

1. Create the new remote project in the intended Supabase account and region.
2. Put its URL and publishable key in `.env.local`; keep the service role key server-only.
3. Run `supabase link --project-ref <new-project-ref>`.
4. Run `supabase db push --dry-run` and review the exact target and SQL.
5. Run `supabase db push` only after the target is confirmed.
