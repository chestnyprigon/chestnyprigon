import assert from "node:assert/strict";
import test from "node:test";
import { allocateProportionally, candidatesNeeded, planBrandSearch, type BrandSearchState } from "../catalog/resumable-search";

const state = (manufacturer: string, fields: Partial<BrandSearchState> = {}): BrandSearchState => ({
  manufacturer, quotaTarget: 10, remainingQuota: 10, searchOffset: 0, scannedCount: 0,
  candidateCount: 0, processedCandidates: 0, conversionRate: null, exhausted: false, ...fields,
});

test("allocates the 50-candidate pilot pool proportionally and deterministically", () => {
  const plan = planBrandSearch([state("Hyundai", { quotaTarget: 80 }), state("Kia", { quotaTarget: 20 })]);
  assert.equal(plan.find((item) => item.manufacturer === "Hyundai")?.candidateTarget, 40);
  assert.equal(plan.find((item) => item.manufacturer === "Kia")?.candidateTarget, 10);
  assert.equal(plan.reduce((sum, item) => sum + item.candidateTarget, 0), 50);
});

test("does not grow the pilot pool again when a previous search already found candidates", () => {
  const plan = planBrandSearch([
    state("Hyundai", { quotaTarget: 80, candidateCount: 40 }),
    state("Kia", { quotaTarget: 20, candidateCount: 10 }),
  ]);
  assert.equal(plan.reduce((sum, item) => sum + item.backlogCandidates + item.candidatesToFind, 0), 50);
  assert.equal(plan.reduce((sum, item) => sum + item.candidatesToFind, 0), 0);
});

test("counts candidate backlog from exhausted brands toward the shared pilot pool", () => {
  const plan = planBrandSearch([
    state("Renault Korea", { quotaTarget: 10, candidateCount: 1, exhausted: true }),
    state("Hyundai", { quotaTarget: 80, candidateCount: 50 }),
  ]);
  assert.equal(plan.reduce((sum, item) => sum + item.backlogCandidates, 0), 51);
  assert.equal(plan.reduce((sum, item) => sum + item.candidatesToFind, 0), 0);
});

test("skips brands whose publication quota is filled and preserves each search offset", () => {
  const plan = planBrandSearch([state("Hyundai", { remainingQuota: 0 }), state("Kia", { searchOffset: 1200 })]);
  assert.equal(plan[0].candidatesToFind, 0);
  assert.equal(plan[1].nextOffset, 1200);
  assert.equal(plan[1].candidatesToFind, 50);
});

test("uses measured pilot conversion after the pilot and subtracts only unprocessed candidates", () => {
  assert.equal(candidatesNeeded(100, 0.5, 20, 50), 180);
  assert.equal(candidatesNeeded(100, 0.5, 220, 50), 0);
  const plan = planBrandSearch([state("BMW", { conversionRate: 0.25, remainingQuota: 40, candidateCount: 60, processedCandidates: 20 })]);
  assert.equal(plan[0].backlogCandidates, 40);
  assert.equal(plan[0].candidatesToFind, 120);
});

test("never searches an exhausted brand", () => {
  assert.equal(planBrandSearch([state("Mazda", { exhausted: true })])[0].candidatesToFind, 0);
});

test("pauses candidate planning when the pilot conversion is zero", () => {
  const plan = planBrandSearch([state("BMW", { conversionRate: 0 })])[0];
  assert.equal(plan.conversionBlocked, true);
  assert.equal(plan.candidatesToFind, 0);
});

test("proportional allocations sum exactly and reject invalid targets", () => {
  assert.deepEqual([...allocateProportionally(7, [{ key: "A", weight: 2 }, { key: "B", weight: 1 }]).values()], [5, 2]);
  assert.throws(() => allocateProportionally(-1, []));
});
