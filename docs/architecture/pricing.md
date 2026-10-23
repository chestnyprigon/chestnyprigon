# Belarus pricing model

The live calculator is `src/lib/pricing/chestny-prigon-profile.ts`. It separates commercial tariffs supplied by the client from statutory Belarus payments.

Profile version: fixed customs-clearance fee policy (40 EUR).

## Commercial tariffs

| Input | Current profile value | Rule |
|---|---:|---|
| KRW per USD | 1,397 | Client commercial rate; update as a versioned tariff |
| Delivery to Minsk | 4,700 USD | Standard passenger-car route tariff |
| Commission | 2.5% | Calculated from source price and delivery |
| SVH and declarant | 150 EUR | Client operational tariff |
| Utilization fee (catalog label) | 400 EUR | Existing client tariff retained in the legacy `customs_clearance_eur` profile column |
| Customs clearance fee | 40 EUR | Fixed amount for every vehicle; included in the Minsk-arrival total |
| Company service | 300 USD | Client service tariff |

## Dynamic statutory calculations

1. USD/BYN and EUR/BYN are obtained from the daily NBRB API. A labelled fallback is used only if NBRB is unavailable.
2. Customs duty is calculated by vehicle age, engine displacement and—only for vehicles up to three years old—customs value. The rates follow the EAEU personal-import brackets.
3. The customer-approved customs-clearance fee is fixed at 40 EUR for every vehicle. It is not converted from BYN and does not vary by vehicle age or NBRB rates.
4. The existing 400 EUR profile tariff is displayed as “Утилизационный сбор” and remains in the Minsk-arrival total. Its current database storage column is named `customs_clearance_eur` for backward compatibility.
5. Preferential treatment affects only customs duty and remains a scenario until the buyer's eligibility is confirmed.

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
