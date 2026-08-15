# Agreed MVP roadmap

Scope: South Korea only, prices shown in USD, no admin panel. Autoexport remains an independent reference project and is never modified by this repository.

| # | Stage | Status | Completion rule |
|---|---|---|---|
| 1 | Approve concept and MVP | Complete | Korea-only scope, no admin panel, paid developer support model agreed |
| 2 | Create standalone project and Supabase | Complete | Independent Next.js and Supabase projects are linked; migrations, RLS and public/private access are verified |
| 3 | Implement Chestny Prigon design | Complete | Main page and catalog UX approved on desktop and mobile |
| 4 | Encar parser and Korea catalog ingestion | First expansion complete | Controlled batches were fetched, normalized and enriched with canonical Encar reports; 84 active normalized vehicles are stored |
| 5 | Filter ineligible/problematic listings | Enrichment checkpoint complete, expansion pending | Versioned screening also applies Encar inspection evidence before public visibility |
| 6 | Vehicle card | Complete for catalog MVP | Real Encar fields, gallery, safe report summary, factory options and itemized calculator are connected |
| 7 | Belarus calculator in USD | Preliminary profile complete | Emavto HAR structure is reproduced and tested; replace versioned rates and company costs after client approval |
| 8 | Contact modal and lead delivery | UI complete, delivery pending | Connect the existing modal/forms to the approved Telegram/CRM/email destination |
| 9 | Testing, SEO, mobile and launch | Partially complete | Final data, performance, accessibility, SEO, analytics and deployment checks pass |
| 10 | Scale catalog to target volume | 1,000-source checkpoint complete | 1,000 canonical Encar listings have passed private ingestion; 590 fully enriched and priced vehicles are public |

## Required implementation order inside stages 4–5

The initial ingestion and filtering are one pipeline, not two independent bulk operations:

`Encar response → private raw row → normalized fields → versioned screening → public catalog`

This prevents confirmed rental, taxi, commercial and technically invalid listings from appearing even temporarily. Accident history is not an exclusion: it is published together with the available Encar evidence. The first parser run must be a limited verification batch; full initial loading begins only after screening precision and update/removal behavior are checked.

## Stage 4–5 pilot checkpoint (2026-08-09)

- Encar domestic stream reported about 61.5k listings matching the initial year, mileage and price envelope before detailed screening.
- Two live 20-row batches completed: 40 unique raw rows, 34 private normalized vehicles and 970 private image rows.
- Five commercial vehicles and one rental version were rejected using structured vehicle fields. Seller marketing text is intentionally not treated as proof of lease/taxi/commercial use because it commonly mentions financing or negates prior use.
- Korean rental plate markers `하`, `허`, `호`, explicit rental/taxi/lease trims, `leaseRentInfo`, commercial body/trim terms and invalid/problem fields are screened before publication.
- Publications are explicit and the database trigger refuses rows that did not pass screening. Canonical Encar report enrichment is required before a listing can be trusted for the public catalog.
- Before scaling, add incremental cursors, retry/backoff, disappearance handling and a representative stratified validation sample rather than relying only on the newest page.

## Stage 6–7 checkpoint (2026-08-09)

- The public catalog now reads the approved Supabase view instead of demo data.
- Canonical Encar options, inspection and accident data are summarized into a separate public-safe report table. Accident history is disclosed in the public card with insurance payments and Encar body findings; it is not a publication blocker by itself.
- The modal card contains an image gallery, normalized specifications, masked VIN, inspection and history summary, factory options, source link and an itemized calculator with a preferential-customs switch.
- The calculator profile reproduces the Emavto HAR rates and branches and is covered by deterministic tests; see `docs/architecture/pricing.md`.
- One hydrogen vehicle remains private because the reference formula cannot calculate its customs duty without guessing.

## First catalog expansion checkpoint (2026-08-12)

- The next controlled 60-row Encar search window was written privately and passed through pricing and canonical report enrichment.
- Supabase now contains 84 active normalized vehicles; 48 are public, 34 are excluded by confirmed rental/taxi/commercial evidence, and 2 remain private because customs pricing cannot be calculated without engine displacement.
- Of the 48 public vehicles, 23 disclose accident history and 13 contain Encar body repair/replacement findings.
- Encar's `ModifiedDate` ordering can change between requests, so numeric offsets are suitable only for controlled batches. Stable incremental ingestion and disappearance handling are required before the next major scale step.

## 1,000-source catalog checkpoint (2026-08-13)

- Private staging contains 1,000 unique canonical Encar listings. All writes were resumable and deduplicated across moving search windows and technical advertising copies.
- 849 listings passed initial normalization and all 849 have canonical option, inspection and accident summaries; report enrichment completed without unavailable reports.
- 590 priced vehicles are public. The remaining normalized vehicles are hidden by confirmed rental/taxi/commercial evidence or insufficient customs-calculation inputs.
- Public disclosure includes accident history for 294 vehicles and body repair/replacement findings for 131 vehicles. Accident history remains informational and is not itself an exclusion.
- Before scaling toward the final 50–80k target, add scheduled incremental refresh, sold/removed detection, stale-row expiration and catalog pagination/performance measurements.
