# Europe customer cohort: VAN and gross-price support

The customer cohort keeps the agreed gates: first registration in 2022–2025 (month precision is accepted), power at or below 160 PS, mileage at or below 100,000 km, a source EUR asking price, and no Neuwagen or unknown registration. It is loaded only from the separate approved Master ID allow-list configured as `MOBILE_DE_CUSTOMER_ALLOWLIST_PATH`.

## Data contract

- Master keeps the original asking amount as gross and keeps any separately reported Netto as a second value. The internal API labels the original amount `price.basis=gross`; `net_price` is returned only when the stored provenance points to `price.nt.amount`.
- The Europe Supabase row stores the original EUR asking amount in `price_amount`, `source_price_basis=gross`, and optional Netto evidence in `net_price_amount`. A missing Netto remains `NULL`; no VAT arithmetic is performed.
- `vehicle_class` comes from Master transport class. The importer does not infer VAN from names such as Vito or Sprinter. Master classifies explicit `Fahrzeugkategorie: Van/Minibus`/`Kategorie: Van/Minibus` evidence and explicit `Kastenwagen` title designations.
- VAN and gross-only rows show the source EU price and do not enter the Belarus turnkey calculator. CAR rows can use the calculator only when source-reported Netto evidence is present and verified.
- Existing 7,333 recovery-approved IDs continue to use `MOBILE_DE_PROVEN_ALLOWLIST_PATH`; the new customer list is a separate file and does not replace that path.

## Import commands

Dry-run up to the first 100 IDs from the new approved cohort:

```sh
npm run mobile-de:import -- --cohort=customer --limit=100
```

Write the validated batch after the Europe-only migration is installed:

```sh
npm run mobile-de:import -- --cohort=customer --limit=100 --write=true --confirm=mobile-de-customer-import
```

The importer uses Master detail reads at a paced rate, upserts only IDs in the selected allow-list, never deletes existing rows or photos, and records each run. Invalid or out-of-rule IDs are skipped and reported. The full source list must be supplied before this command can run for the new cohort.

## Migration and visibility

Apply `supabase/migrations/20261108100000_mobile_de_van_and_gross_price.sql` to the existing Chestny Europe Supabase project. It adds Europe-only columns and replaces only the curated Europe public listing view. RLS remains enabled on the private tables; RAW, credentials, and seller private fields remain excluded. It does not change `mobile_de.enabled` in Master, Encar/Passo, Korea tables, or Production Vercel configuration.
