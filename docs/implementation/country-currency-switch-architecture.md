# Global destination and display-currency selection

Status: architecture checkpoint 4; 2026-11-07. No application code or database was changed in this checkpoint.

## Terms

- **Catalog source** is where the listing comes from: Korea (`/catalog`) or Europe (`/catalog/europe`). It remains a route/data-source choice.
- **Destination** is the import calculation country: Belarus or Russia. This is the global user preference.
- **Display currency** is how the resulting amount is presented. It does not choose a tax regime or change the canonical amount used by the calculation.

The global control should be labelled along the lines of “Расчёт для: Беларусь / Россия”, separate from the existing Korea/Europe source navigation. It appears on the homepage and remains accessible on both catalogs and both detail routes. Do not add a per-vehicle calculation-country selector.

## URL and persistence

Use query keys `destination` and `currency`:

- `destination=by` or `destination=ru`;
- `currency=USD|BYN|RUB|EUR` (case normalized).

Resolution order:

1. A valid explicit value in the current URL wins.
2. Otherwise use the site preference cookie.
3. Otherwise default to Belarus, preserving the current site behavior.

Country defaults are USD for Belarus and RUB for Russia. If the URL or cookie contains a currency unsupported by that destination, use the destination default. When a visitor changes a selector, update the preference cookie and the URL using router navigation so browser back/forward and shared links reproduce the selected view. Preserve active source catalog, filters, sort, pagination and detail `returnTo` while adding/updating these two parameters. Existing URLs with neither parameter remain Belarus links.

Use a small non-sensitive cookie (e.g. `cp_destination=by|ru`, `cp_currency=USD|BYN|RUB|EUR`, path `/`, SameSite=Lax, one-year max age). Cookie state is needed for server rendering and navigation. Do not rely only on localStorage, which cannot set the first server-rendered result.

## Currency behavior

- Belarus remains backward compatible: USD is the default primary price; keep the current approximate BYN presentation. A visitor may select BYN as the primary display currency, with USD as the equivalent.
- Russia calculation always produces and stores the canonical total in RUB. RUB is the default display currency. If the visitor selects USD or EUR, present the converted amount and keep the canonical RUB amount visible as the equivalent in cards and details.
- Currency selection is presentation only. It does not alter price inputs, statutory payment rules, commercial profile values, or the canonical sort/filter amount.
- In the price filter, UI values follow the selected display currency; translate range boundaries server-side to the destination's canonical currency before querying/sorting. Include currency in the URL so a filter link has stable meaning.
- RU conversions use the available official CBR rate snapshot for the initial profile. Keep it a separate display conversion input; do not mix it into the TKS customs base or the commercial KRW/USD rate. BY continues to use the existing NBRB/USD/BYN logic without modification.

## Cross-page behavior

The same preference must be applied on:

- homepage catalog showcase;
- Korean catalog `/catalog`;
- European catalog `/catalog/europe`;
- Korean and European detail pages;
- links back from details and lead submission snapshots.

Changing Belarus/Russia recalculates the same source listing for the selected destination. It must not change the listing source, vehicle, or current search criteria. A detail link carries destination/currency; its return link restores the exact source catalog and filters. The lead calculation snapshot records destination, display currency, canonical amount/currency, selected pricing profile version, TKS version (when RU), and rate snapshot internally.

## Separation of result types

Keep explicit domain types: `BelarusCalculation` with canonical `USD`/existing BYN conversion data and `RussiaCalculation` with canonical `RUB`, separate state-payment rows and Russia commercial profile version. Presentation adapters may format either result but must not accept a mixed-country payment collection. The Belarus `calculateBelarusPrice` API and existing URLs defaulting to Belarus remain compatible.

## Checkpoint 4 architecture acceptance list (UI behavior is implemented and checked in checkpoint 5)

- Global destination selector; no per-card country choice.
- URL overrides cookie; cookie overrides default; default is Belarus.
- Currency defaults by destination and only changes presentation.
- RU canonical RUB total remains available in every card even when alternate display currency is selected.
- Country/currency persist through homepage, both catalog sources, details, filters, pagination, return links and lead snapshots.
- Belarus calculation code and old links retain existing behavior.
