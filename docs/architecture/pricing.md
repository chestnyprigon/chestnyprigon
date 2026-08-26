# Belarus pricing model

The live calculator is `src/lib/pricing/chestny-prigon-profile.ts`. It separates commercial tariffs supplied by the client from statutory Belarus payments.

Profile version: `chestny-prigon-client-table-v2-dynamic-state-fees`.

## Commercial tariffs

| Input | Current profile value | Rule |
|---|---:|---|
| KRW per USD | 1,397 | Client commercial rate; update as a versioned tariff |
| Delivery to Minsk | 4,700 USD | Standard passenger-car route tariff |
| Commission | 2.5% | Calculated from source price and delivery |
| SVH and declarant | 150 EUR | Client operational tariff |
| Handling and accompaniment | 400 EUR | Client operational tariff, not a statutory customs fee |
| Company service | 300 USD | Client service tariff |

## Dynamic statutory calculations

1. USD/BYN and EUR/BYN are obtained from the daily NBRB API. A labelled fallback is used only if NBRB is unavailable.
2. Customs duty is calculated by vehicle age, engine displacement and—only for vehicles up to three years old—customs value. The rates follow the EAEU personal-import brackets.
3. For a M1 vehicle imported by a private person for personal use, utilization fee is calculated in BYN: 624.92 BYN up to three years inclusive and 1,282.02 BYN after three years, effective 2026-04-29. It is then included in the USD total using the NBRB rate.
4. Preferential treatment affects only customs duty and remains a scenario until the buyer's eligibility is confirmed.

The Encar payload currently provides first-registration date rather than an independently verified production date. It is used for the preliminary age group; the final customs amount must be checked against the vehicle documents.

## Recalculation

Refresh saved catalog prices with the same NBRB rate logic used by the UI:

```bash
npm run pricing:recalculate
```

Recalculate and publish only rows with complete pricing inputs and approved screening:

```bash
npm run pricing:recalculate -- --publish
```

The database publication trigger remains the final guard: a rejected or problematic source row cannot be made public by the pricing script.
