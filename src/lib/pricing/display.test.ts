import assert from "node:assert/strict";
import test from "node:test";
import { formatKrwAsUsd, formatUsdWithByn } from "./display";

test("formats the USD price with the current NBRB BYN equivalent", () => {
  assert.equal(formatUsdWithByn(10_000, { usdByn: 3.25, eurByn: 3.5, rateDate: "2026-08-28", source: "nbrb" }), "$10,000 (≈ 32\u00a0500 BYN)");
});

test("keeps unavailable calculations explicit", () => {
  assert.equal(formatUsdWithByn(null, { usdByn: 3.25, eurByn: 3.5, rateDate: "2026-08-28", source: "nbrb" }), "Расчёт уточняется");
});

test("converts KRW insurance payouts to USD with the supplied current rate", () => {
  assert.equal(formatKrwAsUsd(15_140_000, 1_349), "$11,223");
});

test("rounds a KRW insurance payout to whole USD", () => {
  assert.equal(formatKrwAsUsd(1_000, 1_349), "$1");
});

test("rejects an invalid KRW/USD rate", () => {
  assert.equal(formatKrwAsUsd(1_000, 0), "Нет данных");
});
