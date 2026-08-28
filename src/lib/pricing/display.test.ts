import assert from "node:assert/strict";
import test from "node:test";
import { formatUsdWithByn } from "./display";

test("formats the USD price with the current NBRB BYN equivalent", () => {
  assert.equal(formatUsdWithByn(10_000, { usdByn: 3.25, eurByn: 3.5, rateDate: "2026-08-28", source: "nbrb" }), "$10,000 (≈ 32\u00a0500 BYN)");
});

test("keeps unavailable calculations explicit", () => {
  assert.equal(formatUsdWithByn(null, { usdByn: 3.25, eurByn: 3.5, rateDate: "2026-08-28", source: "nbrb" }), "Расчёт уточняется");
});
