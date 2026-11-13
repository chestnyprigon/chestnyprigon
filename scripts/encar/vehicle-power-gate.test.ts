import assert from "node:assert/strict";
import test from "node:test";
import { vehiclePowerFields, vehiclePowerRecordIssue } from "./vehicle-power-gate";

const baseRecord = {
  contractVersion: "power-record-v1",
  propulsion: "ice",
  resolutionClass: "PROBABLE",
  approvalState: "provisional",
  sources: [{ url: "https://example.com/specification" }],
  measurements: [{ basis: "combustion_rated", kw: 150 }],
};

test("accepts source-backed TKS-compatible combustion power and preserves provenance", () => {
  assert.equal(vehiclePowerRecordIssue(baseRecord), null);
  const fields = vehiclePowerFields(baseRecord, "2026-11-13T00:00:00.000Z");
  assert.equal(fields.engine_power_kw, 150);
  assert.equal(fields.power_basis, "combustion_rated");
  assert.equal(fields.power_source_type, "vehicle_power");
  assert.equal(fields.power_confidence, "probable");
  assert.equal(fields.power_source_url, "https://example.com/specification");
});

test("does not treat peak-only electric power as TKS-compatible", () => {
  const electric = { ...baseRecord, propulsion: "electric", measurements: [{ basis: "electric_peak", kw: 180 }] };
  assert.equal(vehiclePowerRecordIssue(electric), "electric_30min_power_missing");
});

test("requires both combustion and 30-minute electric power for a parallel hybrid", () => {
  const hybrid = { ...baseRecord, propulsion: "hybrid_parallel", measurements: [{ basis: "combustion_rated", kw: 110 }] };
  assert.equal(vehiclePowerRecordIssue(hybrid), "hybrid_power_components_missing");
});

test("does not accept a candidate list as a resolved power record", () => {
  assert.equal(vehiclePowerRecordIssue({ ...baseRecord, contractVersion: undefined }), "power_record_contract_invalid");
});
