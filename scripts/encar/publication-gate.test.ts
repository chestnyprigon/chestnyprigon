import assert from "node:assert/strict";
import test from "node:test";
import { publicationGate } from "./publication-gate";
import { classifyEndpointProbe } from "./endpoint-outcomes";
import { screenListing } from "./screening";
import type { EncarBundle } from "./types";

function fixture() {
  const bundle: EncarBundle = { fetchedAt: new Date().toISOString(), search: { Id: "12345", Manufacturer: "BMW", Model: "X5", Year: 202301, Mileage: 12000, Price: 8000, FuelType: "가솔린" },
    detail: { vehicleId: "12345", vehicleNo: "123가4567", advertisement: { status: "ADVERTISE", price: 8000 },
      category: { manufacturerName: "BMW", modelName: "X5", modelYear: 2023 }, spec: { mileage: 12000, displacement: 2998, fuelName: "가솔린", transmissionName: "자동" },
      manage: { modifyDateTime: new Date().toISOString() }, photos: Array.from({ length: 5 }, (_, i) => ({ path: `/carpicture/pic1234/12345_00${i}.jpg` })) } };
  const options = [{ optionName: "sunroof" }];
  const endpointStatus = Object.fromEntries((["options", "inspection", "diagnosis", "insurance"] as const).map(name => [name, classifyEndpointProbe({ endpoint: name, canonicalId: "12345", vehicleNo: "123가4567", httpStatus: name === "options" ? 200 : 404, payload: name === "options" ? options : null })]));
  return { bundle, options, sourceUrl: "https://www.encar.com/dc/dc_cardetailview.do?carid=12345", endpointStatus, rawReports: {} };
}

test("full publication gate permits confirmed absent optional reports and records their evidence", () => {
  const result = publicationGate(fixture());
  assert.equal(result.screening.decision, "approved"); assert.equal(result.reportStatus, "unavailable");
  assert.ok(result.screening.reasonEvidence.some(r => r.code === "insurance_not_found"));
});
test("foreign body/photo/URL/report identifiers cannot be published", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.bundle.detail.photos![0].path = "/carpicture/99999_001.jpg"; },
    (f: ReturnType<typeof fixture>) => { f.sourceUrl = "https://encar.com/?carid=99999"; },
    (f: ReturnType<typeof fixture>) => { f.bundle.detail.category!.manufacturerName = "Mercedes-Benz"; },
    (f: ReturnType<typeof fixture>) => { f.rawReports = { insurance: { vehicleId: "99999", openData: true } }; },
  ]) { const f = fixture(); mutate(f); const r = publicationGate(f); assert.equal(r.screening.decision, "isolated"); assert.equal(r.proof.validated, false); assert.ok(r.screening.reasonEvidence.every(e => e.code && e.explanation && e.source && e.observedAt && e.values)); }
});
test("missing provenance and transient failures are never labelled unavailable", () => {
  const f = fixture(); f.endpointStatus.insurance = classifyEndpointProbe({ endpoint: "insurance", canonicalId: "12345", httpStatus: 503 });
  const result = publicationGate(f); assert.equal(result.reportStatus, null); assert.equal(result.screening.decision, "isolated");
  const g = fixture(); delete g.endpointStatus.insurance.requestedCanonicalId;
  assert.equal(publicationGate(g).screening.decision, "isolated");
});
test("screening rejects confirmed out-of-policy year and mileage with measured reasons", () => {
  const f = fixture(); f.bundle.search.Year = 201501; delete f.bundle.detail.category!.modelYear;
  const r = screenListing(f.bundle); assert.equal(r.decision, "rejected"); assert.ok(r.reasonEvidence.some(e => e.code === "model_year_below_minimum" && e.values.year === 2015));
  f.bundle.search.Year = 202301; f.bundle.detail.spec!.mileage = 190001;
  assert.equal(screenListing(f.bundle).decision, "rejected");
});
test("normalized card mismatch and staged foreign gallery isolate instead of approving", () => {
  const f = fixture(); assert.equal(publicationGate({ ...f, expectedVehicle: { mileageKm: 1 } }).screening.decision, "isolated");
  assert.equal(publicationGate({ ...f, images: ["https://ci.encar.com/carpicture/99999_001.jpg"] }).screening.decision, "isolated");
});
test("inspection usage exclusions include nested Encar title values", () => {
  const f = fixture(); f.rawReports = { inspection: { vehicleId: "12345", master: { detail: { usageChangeTypes: [{ title: "렌트" }] } } } };
  const r = publicationGate(f); assert.equal(r.screening.decision, "rejected"); assert.ok(r.screening.reasonCodes.includes("inspection_usage_excluded"));
});
