import assert from "node:assert/strict";
import test from "node:test";
import { inspectionSummary } from "./enrich";

test("inspection summary marks standard option codes available when Encar includes OPTIONS", () => {
  const summary = inspectionSummary({}, { detail: { options: { standard: ["001", "003"] } } });

  assert.deepEqual(summary.standardOptionCodes, ["001", "003"]);
  assert.equal(summary.standardOptionCodesAvailable, true);
});

test("inspection summary distinguishes omitted OPTIONS from an available empty list", () => {
  const omitted = inspectionSummary({}, { detail: { options: null } });
  const empty = inspectionSummary({}, { detail: { options: { standard: [] } } });

  assert.deepEqual(omitted.standardOptionCodes, []);
  assert.equal(omitted.standardOptionCodesAvailable, false);
  assert.deepEqual(empty.standardOptionCodes, []);
  assert.equal(empty.standardOptionCodesAvailable, true);
});
