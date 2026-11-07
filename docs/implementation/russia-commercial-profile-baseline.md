# Russia commercial pricing profile — baseline v1

Status: approved baseline for preliminary estimates, checkpoint 3; 2026-11-07.

This profile adds commercial costs to the separate Russian TKS result. The Belarus calculator and its current profile remain unchanged. All totals are to be returned in RUB. Statutory Russian payments come only from Vehicle Power TKS and must not be duplicated as commercial fees.

## Korea → Russia

Profile ID/version: `ru-korea-commercial-v1`.

| Line | Baseline | Calculation / treatment |
|---|---:|---|
| Vehicle price | Source listing KRW | Convert with the commercial KRW/USD baseline and then to RUB |
| Commercial KRW/USD rate | Dynamic | Naver/Bithumb USDT/KRW plus the current customer adjustment; independently passed into the Russia commercial profile |
| Korean parking | 440,000 KRW | Existing Korea catalog calculator amount |
| Delivery | 4,900 USD | Existing Belarus commercial route value, reused as the preliminary Russia baseline |
| Commission | 2% | Existing current profile formula: `(rounded vehicle price USD + delivery USD) × 2%` |
| SVH and declarant | 150 EUR | Existing operational/commercial charge |
| Company service | 300 USD | Existing commercial charge |
| Russian TKS payments | TKS response | Keep duty, excise, VAT, recycling fee, and customs processing fee in their own state-payment lines |

Do not copy the Belarus profile's €400 line into the Russian profile: the Belarus UI labels it as utilization fee, while Russia already obtains the statutory recycling fee from TKS. Do not copy the separate €40 Belarus customs-clearance line: the Russian TKS response supplies the applicable customs processing fee. Both are excluded from the Russian commercial subtotal to prevent duplication.

## Europe → Russia

Profile ID/version: `ru-europe-commercial-v1`.

| Line | Baseline | Calculation / treatment |
|---|---:|---|
| Vehicle price | Source listing EUR | Convert to RUB using the profile's live EUR/RUB conversion input |
| EU service | 2.5% | Existing Europe→Belarus profile rate applied to net listing price |
| Translation | 1.5% | Existing Europe→Belarus profile rate applied to `(net price + EU service)` |
| Delivery | 2,200 EUR | Existing Europe→Minsk delivery baseline reused provisionally for the Russia estimate |
| Company service | 1,000 EUR | Existing Europe→Belarus commercial service baseline |
| Belarus recycling fee | Excluded | Belarus-only statutory fee; never add to Russia |
| Russian TKS payments | TKS response | Keep Russian statutory items separate from commercial charges |

The 2,200 EUR delivery value is a provisional transferred commercial baseline because the current project has only a Europe→Minsk amount. It is versioned separately and can be replaced by a Russia route tariff without changing TKS formulas.

## Currency rules

- TKS receives source price currency and uses the official CBR rates included in its rate snapshot to calculate Russian customs value and statutory payments.
- Commercial exchange inputs are separate profile fields. KRW/USD is Naver/Bithumb USDT/KRW plus the current customer adjustment; RUB conversion of USD/EUR costs uses live CBR USD/RUB and EUR/RUB values as the initial Russia baseline. These inputs are independently passed into commercial aggregation and may be changed later without changing TKS or Belarus calculations.
- Do not convert Belarus BYN rates into RUB or reuse NBRB rates for the Russian calculation.
- Round displayed total to whole RUB; retain internal cents in component calculations until aggregation.

## Control examples (fixed fixture rates; not a live quote)

Fixture only: USD/RUB = 90, EUR/RUB = 100, KRW/USD = 1,397. The fixed KRW value keeps the arithmetic reproducible and is not the runtime rate. TKS output is deliberately shown as a separate variable `TKS_RUB`.

### Korea

For a 10,000,000 KRW listing:

- Korea cost incl. parking: `round((10,000,000 + 440,000) / 1,397) = 7,473 USD`.
- Listing price: `round(10,000,000 / 1,397) = 7,158 USD`.
- Commission: `round((7,158 + 4,900) × 2%) = 241 USD`.
- Commercial subtotal: `(7,473 + 4,900 + 241 + 300) × 90 + 150 × 100 = 1,177,260 RUB`.
- Combined preliminary total: `1,177,260 RUB + TKS_RUB`.

### Europe

For a 20,000 EUR net listing:

- EU service: `20,000 × 2.5% = 500 EUR`.
- Translation: `(20,000 + 500) × 1.5% = 307.50 EUR`.
- Commercial subtotal: `(20,000 + 500 + 307.50 + 2,200 + 1,000) × 100 = 2,400,750 RUB`.
- Combined preliminary total: `2,400,750 RUB + TKS_RUB`.

These examples verify currency separation and that Russian statutory rows are added once. The fixed fixture exchange rates are only for reproducible arithmetic; runtime uses the current rate snapshot.

## Data read and change boundary

The current Supabase `belarus-default` profile was read-only checked on 2026-11-07: version `chestny-prigon-client-table-v3-preferential-default`, fallback KRW/USD 1,397, delivery USD 4,900, commission 0.02, SVH/declarant EUR 150, `customs_clearance_eur` EUR 400, `utilization_fee_eur` EUR 0, company service USD 300. The separately stored automatic KRW rate was also read: Naver/Bithumb raw 1,363 KRW/USDT, customer adjustment −9 KRW, effective rate 1,354 KRW/USD, source timestamp 2026-11-07 06:02:53 UTC. This stored rate, not the 1,397 fallback, is used by the normal pricing context while fresh. No database writes were made. The Europe baseline was read from `src/lib/pricing/europe-belarus.ts`. The Belarus calculator, profile rows, and production data were not changed.
