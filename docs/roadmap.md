# Agreed MVP roadmap

Scope: South Korea only, prices shown in USD, no admin panel. Autoexport remains an independent reference project and is never modified by this repository.

| # | Stage | Status | Completion rule |
|---|---|---|---|
| 1 | Approve concept and MVP | Complete | Korea-only scope, no admin panel, paid developer support model agreed |
| 2 | Create standalone project and Supabase | Complete | Independent Next.js and Supabase projects are linked; migrations, RLS and public/private access are verified |
| 3 | Implement Chestny Prigon design | Complete | Main page and catalog UX approved on desktop and mobile |
| 4 | Encar parser and Korea catalog ingestion | Pilot and report enrichment complete | Two controlled batches were fetched, normalized and enriched with canonical Encar reports |
| 5 | Filter ineligible/problematic listings | Enrichment checkpoint complete, expansion pending | Versioned screening also applies Encar inspection evidence before public visibility |
| 6 | Vehicle card | Complete for catalog MVP | Real Encar fields, gallery, safe report summary, factory options and itemized calculator are connected |
| 7 | Belarus calculator in USD | Preliminary profile complete | Emavto HAR structure is reproduced and tested; replace versioned rates and company costs after client approval |
| 8 | Contact modal and lead delivery | UI complete, delivery pending | Connect the existing modal/forms to the approved Telegram/CRM/email destination |
| 9 | Testing, SEO, mobile and launch | Partially complete | Final data, performance, accessibility, SEO, analytics and deployment checks pass |
| 10 | Scale catalog to target volume | Pending | Increase ingestion safely after freshness, filtering and query performance are proven |

## Required implementation order inside stages 4–5

The initial ingestion and filtering are one pipeline, not two independent bulk operations:

`Encar response → private raw row → normalized fields → versioned screening → public catalog`

This prevents lease, rental, taxi, commercial and problematic listings from appearing even temporarily. The first parser run must be a limited verification batch; full initial loading begins only after screening precision and update/removal behavior are checked.

## Stage 4–5 pilot checkpoint (2026-08-09)

- Encar domestic stream reported about 61.5k listings matching the initial year, mileage and price envelope before detailed screening.
- Two live 20-row batches completed: 40 unique raw rows, 34 private normalized vehicles and 970 private image rows.
- Five commercial vehicles and one rental version were rejected using structured vehicle fields. Seller marketing text is intentionally not treated as proof of lease/taxi/commercial use because it commonly mentions financing or negates prior use.
- Korean rental plate markers `하`, `허`, `호`, explicit rental/taxi/lease trims, `leaseRentInfo`, commercial body/trim terms and invalid/problem fields are screened before publication.
- Publications are explicit and the database trigger refuses rows that did not pass screening. Canonical Encar report enrichment is required before a listing can be trusted for the public catalog.
- Before scaling, add incremental cursors, retry/backoff, disappearance handling and a representative stratified validation sample rather than relying only on the newest page.

## Stage 6–7 checkpoint (2026-08-09)

- The public catalog now reads the approved Supabase view instead of demo data.
- Canonical Encar options, inspection and accident data are summarized into a separate public-safe report table. The public catalog currently exposes 9 listings after deeper automatic screening.
- The modal card contains an image gallery, normalized specifications, masked VIN, inspection and history summary, factory options, source link and an itemized calculator with a preferential-customs switch.
- The calculator profile reproduces the Emavto HAR rates and branches and is covered by deterministic tests; see `docs/architecture/pricing.md`.
- One hydrogen vehicle remains private because the reference formula cannot calculate its customs duty without guessing.
