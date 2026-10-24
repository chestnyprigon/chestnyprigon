import assert from "node:assert/strict";
import test from "node:test";
import { allocateProportionally, planBrandSearch, type BrandSearchState } from "../catalog/resumable-search";

const state = (manufacturer: string, fields: Partial<BrandSearchState> = {}): BrandSearchState => ({
  manufacturer, diversityWeight: 10, publishedCount: 0, searchOffset: 0, scannedCount: 0,
  candidateCount: 0, processedCandidates: 0, conversionRate: null, exhausted: false, ...fields,
});

test("keeps brand weights as guidance and includes each non-exhausted brand in search", () => {
  const plan = planBrandSearch([state("Hyundai", { diversityWeight: 80 }), state("Kia", { diversityWeight: 20 })]);
  assert.deepEqual(plan.map((item) => item.manufacturer), ["Hyundai", "Kia"]);
});

test("keeps previous candidates and does not stop at a suggested brand publication target", () => {
  const plan = planBrandSearch([
    state("Renault Korea", { diversityWeight: 10, candidateCount: 1, exhausted: true }),
    state("Hyundai", { diversityWeight: 80, candidateCount: 5_000 }),
  ]);
  assert.equal(plan[0].exhausted, true);
  assert.equal(plan[1].exhausted, false);
  assert.equal(plan[1].candidateCount, 5_000);
});

test("preserves offsets and searches brands even when their recommended publication share is filled", () => {
  const plan = planBrandSearch([state("Hyundai"), state("Kia", { searchOffset: 1200 })]);
  assert.equal(plan[1].nextOffset, 1200);
  assert.equal(plan[0].exhausted, false);
  assert.equal(plan[1].exhausted, false);
});

test("never searches an exhausted brand", () => {
  assert.equal(planBrandSearch([state("Mazda", { exhausted: true })])[0].exhausted, true);
});

test("does not use a low screening conversion as a reason to stop discovery", () => {
  const plan = planBrandSearch([state("BMW", { conversionRate: 0 })])[0];
  assert.equal(plan.exhausted, false);
  assert.equal(plan.conversionRate, 0);
});

test("proportional allocations sum exactly and reject invalid targets", () => {
  assert.deepEqual([...allocateProportionally(7, [{ key: "A", weight: 2 }, { key: "B", weight: 1 }]).values()], [5, 2]);
  assert.throws(() => allocateProportionally(-1, []));
});
