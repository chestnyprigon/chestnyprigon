import assert from "node:assert/strict";
import test from "node:test";
import { calculateBelarusPrice, EMAVTO_PRELIMINARY_PROFILE } from "./emavto-profile";

test("reproduces the Emavto HAR calculation inputs for the captured Volvo", () => {
  const result = calculateBelarusPrice({
    priceKrw: 31_500_000,
    engineCc: 1969,
    firstRegistrationDate: "2022-05-01",
    fuelType: "Бензин",
    preferential: true,
    now: new Date("2026-08-07T12:00:00Z"),
  });

  assert.equal(EMAVTO_PRELIMINARY_PROFILE.version, "emavto-har-2026-08-07-v1");
  assert.equal(result.sourcePriceUsd, 22_404);
  assert.equal(result.koreaAndExportUsd, 24_181);
  assert.equal(result.transitUsd, 1730);
  assert.equal(result.customsDutyUsd, 3068);
  assert.equal(result.totalUsd, 33_929);
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

  assert.equal(regular.customsDutyUsd, preferential.customsDutyUsd * 2);
  assert.equal(regular.totalUsd - preferential.totalUsd, preferential.customsDutyUsd);
});

test("uses zero customs duty for electric vehicles like the reference", () => {
  const result = calculateBelarusPrice({
    priceKrw: 42_000_000,
    engineCc: null,
    firstRegistrationDate: "2024-01-01",
    fuelType: "전기",
  });
  assert.equal(result.customsDutyUsd, 0);
});

test("refuses to guess duty for a non-electric vehicle without displacement", () => {
  assert.throws(() =>
    calculateBelarusPrice({
      priceKrw: 22_000_000,
      engineCc: null,
      firstRegistrationDate: "2022-04-01",
      fuelType: "수소",
    }),
  );
});
