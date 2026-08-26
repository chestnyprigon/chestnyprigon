import assert from "node:assert/strict";
import test from "node:test";
import { calculateBelarusPrice, CHESTNY_PRIGON_PRICING_PROFILE } from "./chestny-prigon-profile";

test("reproduces the client table's KRW, delivery and 2.5 percent first payment", () => {
  const result = calculateBelarusPrice({
    priceKrw: 50_440_000,
    engineCc: 1_500,
    firstRegistrationDate: "2023-05-01",
    fuelType: "Бензин",
    preferential: false,
    now: new Date("2026-08-23T12:00:00Z"),
  });

  assert.equal(CHESTNY_PRIGON_PRICING_PROFILE.version, "chestny-prigon-client-table-v2-dynamic-state-fees");
  assert.equal(result.sourcePriceUsd, 36_106);
  assert.equal(result.deliveryUsd, 4_700);
  assert.equal(result.commissionUsd, 1_020);
  assert.equal(result.firstPaymentUsd, 41_826);
});

test("uses the current Belarus utilization fee by the vehicle age", () => {
  const base = {
    priceKrw: 20_000_000,
    engineCc: 1_598,
    fuelType: "Бензин",
    preferential: false,
    now: new Date("2026-08-26T00:00:00Z"),
  };

  const upToThreeYears = calculateBelarusPrice({ ...base, firstRegistrationDate: "2023-08-26" });
  const overThreeYears = calculateBelarusPrice({ ...base, firstRegistrationDate: "2023-08-25" });

  assert.equal(upToThreeYears.utilizationFeeByn, 624.92);
  assert.equal(overThreeYears.utilizationFeeByn, 1_282.02);
});

test("applies the preferential coefficient only to customs duty", () => {
  const base = {
    priceKrw: 31_500_000,
    engineCc: 1969,
    firstRegistrationDate: "2022-05-01",
    fuelType: "가솔린",
    now: new Date("2026-08-07T12:00:00Z"),
  };
  const preferential = calculateBelarusPrice({ ...base, preferential: true });
  const regular = calculateBelarusPrice({ ...base, preferential: false });

  assert.equal(regular.customsDutyEur, preferential.customsDutyEur! * 2);
  assert.equal(regular.totalUsd! - preferential.totalUsd!, Math.round(preferential.customsDutyEur! / preferential.eurPerUsd));
});

test("does not invent a customs amount for an electric vehicle", () => {
  const result = calculateBelarusPrice({
    priceKrw: 42_000_000,
    engineCc: null,
    firstRegistrationDate: "2024-01-01",
    fuelType: "전기",
  });
  assert.equal(result.customsDutyEur, null);
  assert.equal(result.totalUsd, null);
  assert.equal(result.calculationAvailable, false);
});

test("calculates a hybrid by its combustion-engine displacement", () => {
  const result = calculateBelarusPrice({
    priceKrw: 12_000_000,
    engineCc: 1_598,
    firstRegistrationDate: "2024-01-01",
    fuelType: "가솔린+전기",
    now: new Date("2026-08-24T00:00:00Z"),
  });
  assert.equal(result.calculationAvailable, true);
  assert.equal(result.customsDutyEur, 1_598 * 2.5);
});

test("uses inclusive displacement brackets at legal boundaries", () => {
  const result = calculateBelarusPrice({
    priceKrw: 22_000_000,
    engineCc: 1_000,
    firstRegistrationDate: "2022-04-01",
    fuelType: "Бензин",
    preferential: false,
    now: new Date("2026-08-23T12:00:00Z"),
  });
  assert.equal(result.customsDutyEur, 1_500);
});
