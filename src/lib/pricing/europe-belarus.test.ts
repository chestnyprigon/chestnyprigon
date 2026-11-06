import assert from "node:assert/strict";
import test from "node:test";
import { calculateEuropeBelarusPrice } from "./europe-belarus";

const base = {
  netPriceEur: 20_000,
  firstRegistration: "2021-06-01",
  engineCc: 2_000,
  exchangeRates: { usdByn: 3, eurByn: 3.5, rateDate: "2026-06-01", source: "nbrb" as const },
};

test("selects the tariff at the actual three- and five-year anniversaries", () => {
  const expected = [
    ["2024-05-31", "up_to_three_years"],
    ["2024-06-01", "up_to_three_years"],
    ["2024-06-02", "three_to_five_years"],
    ["2026-05-31", "three_to_five_years"],
    ["2026-06-01", "three_to_five_years"],
    ["2026-06-02", "over_five_years"],
  ] as const;
  for (const [day, band] of expected) {
    assert.equal(calculateEuropeBelarusPrice({ ...base, now: new Date(`${day}T12:00:00Z`) }).ageBand, band, day);
  }
});

test("calculates the agreed commercial charges and changes only customs duty with the benefit", () => {
  const now = new Date("2025-06-01T12:00:00Z");
  const preferential = calculateEuropeBelarusPrice({ ...base, now });
  const regular = calculateEuropeBelarusPrice({ ...base, now, preferential: false });
  assert.equal(preferential.ecServiceEur, 500);
  assert.equal(preferential.translationEur, 307.5);
  assert.equal(preferential.subtotalEur, 24_007.5);
  assert.equal(preferential.customsDutyEur, 2_700);
  assert.equal(regular.customsDutyEur, 5_400);
  assert.equal(preferential.recyclingFeeByn, regular.recyclingFeeByn);
  assert.equal(preferential.totalByn, (24_007.5 + 2_700) * 3.5 + preferential.recyclingFeeByn);
});

test("uses inclusive value thresholds for the up-to-three-year tariff", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const at = (netPriceEur: number, engineCc = 100) => calculateEuropeBelarusPrice({
    ...base,
    netPriceEur,
    engineCc,
    firstRegistration: "2025-01-01",
    now,
    preferential: false,
  }).customsDutyEur;

  assert.equal(at(8_500), 4_590);
  assert.equal(at(8_500.01), 4_080);
  assert.equal(at(16_700), 8_016);
  assert.equal(at(16_700.01), 8_016);

  // The displacement minimum changes at each price tier. A large engine makes
  // the statutory per-cm³ floor visible in the final amount.
  assert.deepEqual([
    at(8_500, 5_000),
    at(8_500.01, 5_000),
    at(16_700, 5_000),
    at(16_700.01, 5_000),
    at(42_300, 5_000),
    at(42_300.01, 5_000),
    at(84_500, 5_000),
    at(84_500.01, 5_000),
    at(169_000, 5_000),
    at(169_000.01, 5_000),
  ], [12_500, 17_500, 17_500, 27_500, 27_500, 37_500, 40_560, 75_000, 81_120, 100_000]);
});

test("uses inclusive engine-displacement limits for vehicles older than three years", () => {
  const calculate = (firstRegistration: string, engineCc: number) => calculateEuropeBelarusPrice({
    ...base,
    netPriceEur: 1,
    firstRegistration,
    engineCc,
    now: new Date("2026-01-01T12:00:00Z"),
    preferential: false,
  }).customsDutyEur;

  const cases = [
    ["2022-01-01", [[1_000, 1_500], [1_001, 1_701.7], [1_500, 2_550], [1_501, 3_752.5], [1_800, 4_500], [1_801, 4_862.7], [2_300, 6_210], [2_301, 6_903], [3_000, 9_000], [3_001, 10_803.6]]],
    ["2020-01-01", [[1_000, 3_000], [1_001, 3_203.2], [1_500, 4_800], [1_501, 5_253.5], [1_800, 6_300], [1_801, 8_644.8], [2_300, 11_040], [2_301, 11_505], [3_000, 15_000], [3_001, 17_105.7]]],
  ] as const;

  for (const [registration, thresholds] of cases) {
    for (const [engineCc, expected] of thresholds) {
      assert.equal(calculate(registration, engineCc), expected, `${registration}, ${engineCc} cc`);
    }
  }
});

test("uses month precision for first registration and rejects future dates or an unofficial exchange rate", () => {
  assert.throws(() => calculateEuropeBelarusPrice({ ...base, now: new Date("2021-05-31T12:00:00Z") }));
  assert.equal(calculateEuropeBelarusPrice({ ...base, firstRegistration: "2021-06", now: new Date("2024-06-01T12:00:00Z") }).ageBand, "up_to_three_years");
  assert.throws(() => calculateEuropeBelarusPrice({ ...base, exchangeRates: { ...base.exchangeRates, source: "fallback" } }));
});
