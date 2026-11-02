# Europe catalogue: Supabase Preview cutover

Scope: only the Europe/Mobile.de catalogue, the existing Chestny Prigon Supabase project, and branch `codex/catalog-europe`. Korea tables and Production stay untouched.

## Locked execution order

1. Confirm the Master API detail contract for the 7,333 recovery-approved rows. Each row must carry the immutable Master ID, explicit `PROVEN / VERIFIED` proof, exact first-registration date, PS power, mileage, one of the three allowed price categories, EUR price, and ordered image URLs. A total of 7,333 in a recovery report is not enough to infer the eligible IDs. If source availability is `unknown`, the recovery proof is the evidence of activity at verification time; any explicit removed/inactive status is rejected.
2. Apply `supabase/migrations/20261103120000_europe_catalog_tables.sql` to the already-existing Chestny Prigon Supabase project. It creates only the `mobile_de_catalog_*` objects and does not alter Korean catalogue tables. Base Europe tables stay private; the website receives read-only access through curated public views containing only visible catalogue rows and ordered gallery URLs.
3. Make a dry-run against a small, deterministic prefix of the exact recovery allow-list. Inspect rejection counts and a few anonymized mapped records before writing. A record is never made visible unless all eligibility checks pass.
4. Write the small test batch with `npm run mobile-de:import -- --limit=100 --write=true --confirm=mobile-de-test-import`. Verify row counts, uniqueness, all eligibility constraints, image count/order, public views versus private base-table access, facets, filtering, listing, and detail through a temporary Preview-only source switch.
5. Import the full approved list idempotently in batches. The script records progress and uses Master ID as the stable key. It must report accepted plus rejected counts; unexplained loss from the 7,333 allow-list stops the cutover.
6. Verify the full data set and Korean isolation. Set `EUROPE_SUPABASE_URL` and `EUROPE_CATALOG_SOURCE=supabase` only for Vercel Preview, redeploy the Preview deployment, and check filters, pagination, cards, detail, and galleries at `chestny-prigon.vercel.app`. The Europe reader uses the existing Preview publishable key; do not add the Supabase service-role key to Vercel Preview.
7. Commit and push to `origin/codex/catalog-europe`; confirm Vercel produced a Preview deployment and the Preview smoke checks pass. Do not merge to `main`, change Production variables, use a Production alias, or run a Production deployment.

## Importer input and safety

`MOBILE_DE_PROVEN_ALLOWLIST_PATH` must point to a local JSON file with either a string array or `{ "master_ids": [...] }`. It must contain exactly 7,333 unique Master IDs. Keep that recovery file in ignored `.local/` and do not log raw descriptions or personal seller data. The API token, Supabase URL, service key, and allow-list path can be set in ignored `.env.local`; never commit or paste credentials into chat. The importer runs in dry-run mode unless `--write=true` is explicitly supplied. `--limit=100` is the maximum pilot batch. Detail requests are paced below the consumer's 60 requests/minute limit; reading 7,333 records through the detail API will take about 2 hours. The full import requires `--confirm=mobile-de-full-import-7333` and refuses to write if any approved ID fails the strict data checks.

Only external image URLs are copied into the `mobile_de_catalog_images` table. Image bytes remain on the source CDN; this import does not upload media into Supabase Storage.

## Current readiness

- Local schema, typed Supabase adapter, and import script are prepared.
- TypeScript and targeted ESLint checks pass.
- No Supabase migration or import has been executed yet. The local environment has no Supabase credentials, and the current browser session needs a user sign-in to the Supabase account that owns the project. The source project/recovery export has not been added to this repository.
- Master API's exact proof, active, first-registration, price-category, and gallery fields must be matched to a real anonymized detail response before the import can run. The script fails closed if a row does not satisfy these criteria.
