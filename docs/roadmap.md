# Agreed MVP roadmap

Scope: South Korea only, prices shown in USD, no admin panel. Autoexport remains an independent reference project and is never modified by this repository.

| # | Stage | Status | Completion rule |
|---|---|---|---|
| 1 | Approve concept and MVP | Complete | Korea-only scope, no admin panel, paid developer support model agreed |
| 2 | Create standalone project and Supabase | In progress | Next.js project is separate; local Supabase schema is ready; a new remote project must be created and linked in the intended account |
| 3 | Implement Chestny Prigon design | Complete | Main page and catalog UX approved on desktop and mobile |
| 4 | Encar parser and Korea catalog ingestion | Next | A controlled test batch is fetched into private raw storage and normalized |
| 5 | Filter ineligible/problematic listings | Designed with stage 4 | Screening runs before publication; rejected rows remain private |
| 6 | Vehicle card | UI complete | Replace demo content with normalized Encar fields, photos, history and availability |
| 7 | Belarus calculator in USD | Pending | Implement the provisional Emavto-compatible structure, then replace constants with client-approved tariffs/formula |
| 8 | Contact modal and lead delivery | UI complete, delivery pending | Connect the existing modal/forms to the approved Telegram/CRM/email destination |
| 9 | Testing, SEO, mobile and launch | Partially complete | Final data, performance, accessibility, SEO, analytics and deployment checks pass |
| 10 | Scale catalog to target volume | Pending | Increase ingestion safely after freshness, filtering and query performance are proven |

## Required implementation order inside stages 4–5

The initial ingestion and filtering are one pipeline, not two independent bulk operations:

`Encar response → private raw row → normalized fields → versioned screening → public catalog`

This prevents lease, rental, taxi, commercial and problematic listings from appearing even temporarily. The first parser run must be a limited verification batch; full initial loading begins only after screening precision and update/removal behavior are checked.
