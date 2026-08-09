# Preliminary Belarus pricing profile

The initial calculator reproduces the structure observed in the user-provided Emavto HAR capture from 2026-08-07. It is deliberately isolated in `src/lib/pricing/emavto-profile.ts`, so client-specific rates can replace the profile without changing catalog or vehicle-card components.

Profile version: `emavto-har-2026-08-07-v1`.

## Captured rates and fixed costs

| Input | Value |
|---|---:|
| KRW per USD | 1406 |
| KRW per EUR | 1608 |
| EUR per USD | 0.8664 |
| RUB per USD | 80.93 |
| Fixed Korea amount | 1,200,000 KRW |
| Export extra | 1,060 USD |
| Delivery to Minsk | 4,050 USD |
| Transit declaration | 140,000 RUB |
| Customs warehouse, payments and recycling | 600 USD |
| Selection and transaction support | 300 USD |

## Calculation structure

1. Convert the Encar price from units of 10,000 KRW to KRW.
2. Apply the Korean tax adjustment used by the reference: `price / 1.1 × 0.1 × 0.4`.
3. Korea/export block: `(price − adjustment + 1,200,000) × 1.01 × 1.02 / KRW_USD + 1,060`.
4. Convert the transit amount from RUB to USD.
5. Calculate customs duty by the vehicle's full age in months and engine displacement:
   - under 3 years: maximum of the customs-value percentage and EUR-per-cc bracket;
   - 3–5 years: EUR-per-cc bracket from 1.5 to 3.6;
   - over 5 years: EUR-per-cc bracket from 3.0 to 5.7;
   - explicit electric fuel: zero duty in the captured reference formula.
6. The enabled preferential option halves customs duty only.
7. Add Korea/export, delivery, transit, customs duty, customs services and company services.

Every displayed value is marked preliminary. Cars without a registration date, or non-electric cars without engine displacement, are not published with a guessed price. The first pilot therefore publishes 33 of 34 normalized vehicles; Hyundai Nexo stays private until a client-approved hydrogen rule exists.

## Recalculation

Recalculate private values:

```bash
npm run pricing:recalculate
```

Recalculate and publish only rows with complete pricing inputs and approved screening:

```bash
npm run pricing:recalculate -- --publish
```

The database publication trigger remains the final guard: a rejected or problematic source row cannot be made public by the pricing script.
