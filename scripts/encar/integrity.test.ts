import assert from "node:assert/strict";
import test from "node:test";
import { validateEnrichmentIntegrity, validateExistingIdentityLinks, validateQueueIdentity, validateSnapshotAgainstDetail } from "./integrity";
import type { EncarBundle } from "./types";

const snapshot = {
  Id: "12345",
  Manufacturer: "Mercedes-Benz",
  Model: "E-Class",
  Year: 202301,
  FormYear: 2023,
  Mileage: 20_000,
  Price: 8_000,
};

function bundle(overrides: Partial<EncarBundle["detail"]> = {}): EncarBundle {
  return {
    fetchedAt: "2026-10-06T00:00:00.000Z",
    search: { ...snapshot },
    detail: {
      vehicleId: "canonical-900",
      vehicleNo: "123가4567",
      category: { manufacturerName: "Mercedes-Benz", modelName: "E-Class" },
      spec: {},
      ...overrides,
    },
  };
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    queueSourceListingId: "12345",
    queueSourceUrl: "https://www.encar.com/dc/dc_cardetailview.do?carid=12345",
    stagingSourceListingId: "12345",
    vehicleSourceListingId: "12345",
    snapshot,
    ...overrides,
  };
}

test("allows advertised listing ID to differ from Encar canonical vehicle ID", () => {
  assert.deepEqual(validateEnrichmentIntegrity(identity(), bundle()), []);
});

test("detects staging, vehicle and missing canonical ID conflicts after detail fetch", () => {
  const issues = validateEnrichmentIntegrity(identity({
    queueSourceUrl: "https://www.encar.com/dc/dc_cardetailview.do?carid=99999",
    stagingSourceListingId: "88888",
    vehicleSourceListingId: "77777",
    snapshot: { ...snapshot, Id: "66666" },
  }), bundle({ vehicleId: undefined }));
  const codes = issues.map((issue) => issue.code);
  assert.ok(codes.includes("identity_staging_id_mismatch"));
  assert.ok(codes.includes("identity_vehicle_id_mismatch"));
  assert.ok(codes.includes("identity_canonical_id_missing"));
});

test("detects source identifier collisions", () => {
  const issues = validateEnrichmentIntegrity(identity({
    expectedVehicleId: "vehicle-1",
    linkedSourceIdentifiers: [{ value: "12345", vehicleId: "vehicle-2" }],
  }), bundle());
  assert.ok(issues.some((issue) => issue.code === "identity_source_identifier_collision"));
});

test("detects field conflicts and reports source values", () => {
  const issues = validateEnrichmentIntegrity(identity({
    snapshot: { ...snapshot, Manufacturer: "BMW", Mileage: 30_000 },
  }), bundle({ category: { manufacturerName: "BMW", modelName: "E-Class" } }));
  const codes = issues.map((issue) => issue.code);
  assert.ok(codes.includes("integrity_snapshot_manufacturer_mismatch"));
  assert.ok(codes.includes("integrity_snapshot_mileage_mismatch"));
  assert.ok(issues.every((issue) => issue.source && issue.field));
});

test("validates queue URL and snapshot before an Encar request", () => {
  const issues = validateQueueIdentity(identity({
    queueSourceUrl: "https://www.encar.com/dc/dc_cardetailview.do?carid=wrong",
    snapshot: { ...snapshot, Id: "other" },
  }));
  assert.deepEqual(issues.map((issue) => issue.code), ["identity_snapshot_id_mismatch", "identity_url_carid_mismatch"]);
});

test("blocks already-owned staging and catalog identifiers with provenance", () => {
  const issues = validateExistingIdentityLinks("12345", "canonical-900", {
    staging: [{ source_listing_id: "12345", advertisedId: "12345", canonicalId: "canonical-900" }],
    vehicles: [{ id: "vehicle-1", source_listing_id: "canonical-900" }],
    sourceIdentifiers: [{ source_identifier: "12345", vehicle_id: "vehicle-1" }],
  });
  assert.deepEqual(issues.map((issue) => issue.code), [
    "identity_existing_staging_duplicate",
    "identity_catalog_source_id_already_exists",
    "identity_source_identifier_already_linked",
  ]);
  assert.ok(issues.every((issue) => issue.source));
});

test("detects a source identifier mapped to a different catalog vehicle", () => {
  const issues = validateExistingIdentityLinks("12345", "canonical-900", {
    staging: [],
    vehicles: [{ id: "other-vehicle", source_listing_id: "another-canonical" }],
    sourceIdentifiers: [{ source_identifier: "12345", vehicle_id: "other-vehicle", vehicle_source_listing_id: "another-canonical" }],
  });
  assert.ok(issues.some((issue) => issue.code === "identity_source_identifier_vehicle_conflict"));
});

test("does not confuse raw Encar price units with normalized KRW", () => {
  const candidateSnapshot = { ...snapshot, priceKrw: 80_000_000 };
  const candidate = { ...bundle(), search: candidateSnapshot };
  assert.deepEqual(validateEnrichmentIntegrity(identity({ snapshot: candidateSnapshot }), candidate), []);
});

test("accepts equivalent Korean and English make, fuel and transmission labels", () => {
  const source = { ...snapshot, Manufacturer: "벤츠", FuelType: "가솔린", Transmission: "Automatic", EngineCc: 2_000 };
  const candidate = bundle({
    category: { manufacturerName: "Mercedes-Benz", modelName: "E-Class" },
    spec: { fuelName: "휘발유", transmissionName: "자동", engineCc: 1_991 },
  });
  assert.deepEqual(validateSnapshotAgainstDetail(source, candidate), []);
});

test("blocks clear make, powertrain, transmission and displacement conflicts", () => {
  const source = { ...snapshot, Manufacturer: "BMW", FuelType: "가솔린", Transmission: "자동", EngineCc: 2_000 };
  const candidate = bundle({
    category: { manufacturerName: "Mercedes-Benz", modelName: "E-Class" },
    spec: { fuelName: "디젤", transmissionName: "수동", engineCc: 3_000 },
  });
  const codes = validateSnapshotAgainstDetail(source, candidate).map((issue) => issue.code);
  assert.ok(codes.includes("integrity_manufacturer_conflict"));
  assert.ok(codes.includes("integrity_powertrain_conflict"));
  assert.ok(codes.includes("integrity_transmission_conflict"));
  assert.ok(codes.includes("integrity_engine_displacement_conflict"));
});

test("blocks explicit model-family and model-year conflicts", () => {
  const source = { ...snapshot, Model: "X5", Year: 202301, FormYear: 2023 };
  const candidate = bundle({
    category: { manufacturerName: "BMW", modelGroupEnglishName: "X3", modelYear: 2022 },
  });
  const codes = validateSnapshotAgainstDetail(source, candidate).map((issue) => issue.code);
  assert.ok(codes.includes("integrity_model_family_conflict"));
  assert.ok(codes.includes("integrity_model_year_conflict"));
});

test("does not compare model year to first registration month", () => {
  const candidate = bundle({ category: { manufacturerName: "Mercedes-Benz", modelGroupEnglishName: "E-Class", yearMonth: "202212" } });
  assert.deepEqual(validateSnapshotAgainstDetail(snapshot, candidate), []);
});

test("records price and mileage drift as warnings for the current detail data", () => {
  const source = { ...snapshot, Price: 8_000, Mileage: 20_000 };
  const candidate = bundle({
    advertisement: { price: 7_900 },
    spec: { mileage: 20_500 },
  });
  const issues = validateSnapshotAgainstDetail(source, candidate);
  assert.deepEqual(issues.map((issue) => issue.code), ["integrity_mileage_drift", "integrity_price_drift"]);
  assert.ok(issues.every((issue) => issue.severity === "warning"));
});
