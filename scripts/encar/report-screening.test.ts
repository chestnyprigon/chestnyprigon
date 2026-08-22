import assert from "node:assert/strict";
import test from "node:test";
import { reportScreening } from "./report-screening";

test("publishes an otherwise eligible vehicle with disclosed accident history", () => {
  const result = reportScreening({ rental: false, taxi: false, commercial: false }, true);
  assert.equal(result.decision, "approved");
  assert.equal(result.isProblematic, false);
  assert.deepEqual(result.reasonCodes, ["encar_accident_history"]);
});

test("keeps rental, taxi and commercial history as hard exclusions", () => {
  for (const flags of [
    { rental: true, taxi: false, commercial: false },
    { rental: false, taxi: true, commercial: false },
    { rental: false, taxi: false, commercial: true },
  ]) {
    assert.equal(reportScreening(flags, true).decision, "rejected");
  }
});

test("keeps a vehicle public when the Encar report is unavailable", () => {
  const result = reportScreening({ rental: false, taxi: false, commercial: false }, false, false);
  assert.equal(result.decision, "approved");
  assert.equal(result.hardExclusion, false);
  assert.deepEqual(result.reasonCodes, ["encar_report_unavailable"]);
});
