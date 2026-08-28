import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG_WAVES, MAX_ENRICH_CONCURRENCY, SAFE_BRAND_BATCH_SIZE, SAFE_ENRICH_CONCURRENCY, selectWaveBatches, totalWaveQuota, waveBatches } from "./waves";

test("keeps Korean and European quotas separate", () => {
  assert.equal(totalWaveQuota("european"), 7_000);
  assert.equal(totalWaveQuota("korean"), 7_500);
  assert.equal(totalWaveQuota(), 17_000);
});

test("splits a brand quota into bounded resumable batches", () => {
  const wave = CATALOG_WAVES.find((item) => item.id === "eu-01-bmw");
  assert.ok(wave);
  const batches = waveBatches(wave);
  assert.equal(batches.length, 4);
  assert.deepEqual(batches[0], { waveId: "eu-01-bmw", manufacturer: "BMW", offset: 0, limit: SAFE_BRAND_BATCH_SIZE });
  assert.deepEqual(batches.at(-1), { waveId: "eu-01-bmw", manufacturer: "BMW", offset: 1_500, limit: 500 });
});

test("rejects unsafe batch sizes", () => {
  const wave = CATALOG_WAVES[0];
  assert.throws(() => waveBatches(wave, 49), /from 50/);
  assert.throws(() => waveBatches(wave, SAFE_BRAND_BATCH_SIZE + 1), /from 50/);
});

test("keeps enrichment concurrency bounded", () => {
  assert.equal(SAFE_ENRICH_CONCURRENCY, 3);
  assert.equal(MAX_ENRICH_CONCURRENCY, 4);
});

test("balances the first bulk target across selected brand groups", () => {
  const batches = selectWaveBatches(2_000, ["european", "korean"]);
  assert.deepEqual(batches.map((batch) => batch.wave.id), ["eu-01-bmw", "kr-01-hyundai", "eu-02-mercedes", "kr-02-kia"]);
  assert.deepEqual(batches.map((batch) => batch.limit), [500, 500, 500, 500]);
});
