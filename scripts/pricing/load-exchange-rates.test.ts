import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { loadRecalculationRates, validStoredRates } from "./load-exchange-rates";

test("August fallback, future dates and invalid numbers cannot become October rates", () => {
  const now = new Date("2026-10-06T10:00:00Z");
  const row = { rate_date: "2026-10-05", usd_byn: 3, eur_byn: 3.4 };
  assert.ok(validStoredRates(row, now));
  assert.equal(validStoredRates({ ...row, rate_date: "2026-08-23" }, now), null);
  assert.equal(validStoredRates({ ...row, rate_date: "2026-10-07" }, now), null);
  assert.equal(validStoredRates({ ...row, usd_byn: 0 }, now), null);
});

function db(cache: unknown, methods: string[]) {
  return createClient("https://example.supabase.co", "test-key", {
    global: { fetch: async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return new Response(JSON.stringify(cache), { headers: { "Content-Type": "application/json" } });
    } },
  });
}

test("provider failure preserves last successful cached rates without writing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("provider offline"); });
  t.mock.method(console, "warn", () => {});
  const methods: string[] = [];
  const rateDate = new Date().toISOString().slice(0, 10);
  const rates = await loadRecalculationRates(db({ rate_date: rateDate, usd_byn: 3, eur_byn: 3.4 }, methods), false);
  assert.equal(rates.usdByn, 3);
  assert.equal(rates.rateDate, rateDate);
  assert.deepEqual(methods, ["GET"]);
});

test("provider failure with obsolete cache aborts before any write", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("provider offline"); });
  const methods: string[] = [];
  await assert.rejects(loadRecalculationRates(db({ rate_date: "2000-01-01", usd_byn: 3, eur_byn: 3.4 }, methods), false), /prices were not recalculated/);
  assert.deepEqual(methods, ["GET"]);
});

test("dry-run does not write the rate cache even after a successful fetch", async (t) => {
  const rateDate = new Date().toISOString().slice(0, 10);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify([
    { Cur_Abbreviation: "USD", Cur_OfficialRate: 3, Cur_Scale: 1, Date: rateDate },
    { Cur_Abbreviation: "EUR", Cur_OfficialRate: 3.4, Cur_Scale: 1, Date: rateDate },
  ]), { headers: { "Content-Type": "application/json" } }));
  const methods: string[] = [];
  const rates = await loadRecalculationRates(db(null, methods), true);
  assert.equal(rates.usdByn, 3);
  assert.deepEqual(methods, ["GET"]);
});
