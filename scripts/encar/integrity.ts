import type { EncarBundle, EncarSearchListing, UnknownRecord } from "./types";
import { MANUFACTURER_ALIASES } from "./manufacturer-aliases";

export type IntegrityIssue = {
  code: string;
  field: string;
  expected: unknown;
  actual: unknown;
  source: string;
  severity?: "blocker" | "warning";
};

export type EnrichmentIdentity = {
  queueSourceListingId: string;
  queueSourceUrl?: string | null;
  stagingSourceListingId?: string | null;
  vehicleSourceListingId?: string | null;
  expectedVehicleId?: string | null;
  linkedSourceIdentifiers?: Array<{ value: string; vehicleId: string }>;
  snapshot: EncarSearchListing & UnknownRecord;
};

export type ExistingIdentityRows = {
  staging: Array<{ source_listing_id: string; advertisedId?: string | null; canonicalId?: string | null }>;
  vehicles: Array<{ id: string; source_listing_id: string }>;
  sourceIdentifiers: Array<{ source_identifier: string; vehicle_id: string; vehicle_source_listing_id?: string | null }>;
};

const normalizedText = (value: unknown) => String(value ?? "").trim().toLocaleLowerCase();
const asNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function priceKrw(value: UnknownRecord | EncarSearchListing) {
  const normalized = asNumber(value.priceKrw);
  if (normalized !== null) return normalized;
  const source = asNumber(value.Price);
  return source === null ? null : source * 10_000;
}

function modelYear(value: UnknownRecord | EncarSearchListing) {
  const encoded = asNumber(value.Year);
  if (encoded !== null && encoded >= 190000) return Math.floor(encoded / 100);
  return asNumber(value.FormYear);
}

function explicitModelYear(value: unknown) {
  const year = asNumber(value);
  if (year === null) return null;
  if (year >= 190000) return Math.floor(year / 100);
  return Number.isInteger(year) && year >= 1990 && year <= 2100 ? year : null;
}

function modelTokens(value: unknown) {
  return normalizedText(value)
    .normalize("NFKC")
    .match(/[a-z0-9]+|[가-힣]+/gu)
    ?.filter((token) => !["the", "new", "더", "뉴", "class", "series", "시리즈", "model", "모델"].includes(token)) ?? [];
}

function clearModelConflict(expected: unknown, actual: unknown) {
  const left = normalizedText(expected);
  const right = normalizedText(actual);
  if (!left || !right || left === right) return false;
  const leftHangul = /[가-힣]/u.test(left);
  const rightHangul = /[가-힣]/u.test(right);
  const leftLatin = /[a-z]/iu.test(left);
  const rightLatin = /[a-z]/iu.test(right);
  const leftTokens = modelTokens(left);
  const rightTokens = modelTokens(right);
  if (leftTokens.some((token) => rightTokens.includes(token))) return false;
  // Different scripts can be transliterations of the same model; only block
  // a mismatch when both sides can be compared in the same writing system.
  return (leftHangul && rightHangul && !leftLatin && !rightLatin) || (leftLatin && rightLatin && !leftHangul && !rightHangul);
}

function addMismatch(
  issues: IntegrityIssue[],
  code: string,
  field: string,
  expected: unknown,
  actual: unknown,
  source: string,
  severity: "blocker" | "warning" = "blocker",
) {
  if (normalizedText(expected) === normalizedText(actual)) return;
  issues.push({ code, field, expected: expected ?? null, actual: actual ?? null, source, severity });
}

function manufacturerKey(value: unknown) {
  const normalized = normalizedText(value);
  for (const [brand, aliases] of Object.entries(MANUFACTURER_ALIASES)) {
    if ([brand, ...aliases].some((alias) => normalizedText(alias) === normalized)) return brand;
  }
  return null;
}

function fuelClass(value: unknown) {
  const normalized = normalizedText(value);
  if (!normalized) return null;
  if (/하이브리드|hybrid|hev|phev|plug[ -]?in|가솔린\s*\+\s*전기|디젤\s*\+\s*전기/u.test(normalized)) return "hybrid";
  if (/수소|hydrogen/u.test(normalized)) return "hydrogen";
  if (/전기|electric|\bev\b/u.test(normalized)) return "electric";
  if (/경유|디젤|diesel/u.test(normalized)) return "diesel";
  if (/휘발유|가솔린|gasoline|petrol/u.test(normalized)) return "gasoline";
  if (/lpg|엘피지|액화석유/u.test(normalized)) return "lpg";
  return null;
}

function transmissionClass(value: unknown) {
  const normalized = normalizedText(value);
  if (!normalized) return null;
  if (/cvt|무단/u.test(normalized)) return "cvt";
  if (/dct|dual.?clutch|듀얼/u.test(normalized)) return "dct";
  if (/수동|manual/u.test(normalized)) return "manual";
  if (/자동|automatic|auto/u.test(normalized)) return "automatic";
  return null;
}

function engineCc(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).replace(/,/g, ".").replace(/\s+/g, " ").trim();
  const amount = asNumber(raw.replace(/[^0-9.]/g, ""));
  if (amount === null || amount <= 0) return null;
  return amount < 20 ? amount * 1_000 : amount;
}

function firstEngineCc(record: UnknownRecord, keys: string[]) {
  for (const key of keys) {
    const value = engineCc(record[key]);
    if (value !== null && value > 0) return value;
  }
  return null;
}

export function validateSnapshotAgainstDetail(snapshot: EncarSearchListing & UnknownRecord, bundle: EncarBundle): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const detail = bundle.detail as UnknownRecord;
  const category = (detail.category && typeof detail.category === "object" ? detail.category : {}) as UnknownRecord;
  const spec = (detail.spec && typeof detail.spec === "object" ? detail.spec : {}) as UnknownRecord;
  const advertisement = (detail.advertisement && typeof detail.advertisement === "object" ? detail.advertisement : {}) as UnknownRecord;

  const expectedBrand = manufacturerKey(snapshot.Manufacturer);
  const actualBrand = manufacturerKey(category.manufacturerName ?? spec.manufacturerName);
  if (expectedBrand && actualBrand) addMismatch(issues, "integrity_manufacturer_conflict", "manufacturer", expectedBrand, actualBrand, "candidate_snapshot ↔ encar.detail.category");
  else if (snapshot.Manufacturer && (category.manufacturerName ?? spec.manufacturerName)
    && normalizedText(snapshot.Manufacturer) !== normalizedText(category.manufacturerName ?? spec.manufacturerName)) {
    issues.push({ code: "integrity_manufacturer_comparison_unconfirmed", field: "manufacturer", expected: snapshot.Manufacturer,
      actual: category.manufacturerName ?? spec.manufacturerName, source: "candidate_snapshot ↔ encar.detail.category", severity: "blocker" });
  }

  const expectedModel = snapshot.Model;
  const modelNames = [category.modelGroupEnglishName, category.modelGroupName, category.modelName].filter(value => typeof value === "string" && value);
  const matchingName = modelNames.find(value => normalizedText(value) === normalizedText(expectedModel)
    || modelTokens(value).some(token => modelTokens(expectedModel).includes(token)));
  const actualModel = matchingName ?? modelNames[0];
  if (clearModelConflict(expectedModel, actualModel)) {
    issues.push({ code: "integrity_model_family_conflict", field: "model", expected: expectedModel, actual: actualModel, source: "candidate_snapshot ↔ encar.detail.category", severity: "blocker" });
  }
  else if (expectedModel && actualModel && !matchingName) {
    issues.push({ code: "integrity_model_comparison_unconfirmed", field: "model", expected: expectedModel, actual: actualModel,
      source: "candidate_snapshot ↔ encar.detail.category model aliases", severity: "blocker" });
  }

  const expectedYear = modelYear(snapshot);
  const actualYear = explicitModelYear(detail.modelYear ?? category.modelYear ?? spec.modelYear);
  if (expectedYear !== null && actualYear !== null) {
    addMismatch(issues, "integrity_model_year_conflict", "model_year", expectedYear, actualYear, "candidate_snapshot ↔ encar.detail.modelYear");
  }

  const expectedFuel = fuelClass(snapshot.FuelType);
  const actualFuel = fuelClass(spec.fuelName);
  if (expectedFuel && actualFuel) addMismatch(issues, "integrity_powertrain_conflict", "fuel_type", expectedFuel, actualFuel, "candidate_snapshot ↔ encar.detail.spec");

  const expectedTransmission = transmissionClass(snapshot.Transmission ?? snapshot.Gearbox ?? snapshot.transmission);
  const actualTransmission = transmissionClass(spec.transmissionName);
  if (expectedTransmission && actualTransmission) addMismatch(issues, "integrity_transmission_conflict", "transmission", expectedTransmission, actualTransmission, "candidate_snapshot ↔ encar.detail.spec");

  const expectedEngine = firstEngineCc(snapshot, ["EngineCc", "EngineCC", "EngineDisplacement", "Displacement", "EngineVolume"]);
  const actualEngine = engineCc(spec.displacement ?? spec.engineDisplacement ?? spec.engineCc ?? spec.engineVolume ?? spec.cc ?? category.displacement ?? category.engineDisplacement);
  if (expectedEngine !== null && actualEngine !== null && Math.abs(expectedEngine - actualEngine) > 100) {
    addMismatch(issues, "integrity_engine_displacement_conflict", "engine_cc", expectedEngine, actualEngine, "candidate_snapshot ↔ encar.detail.spec");
  }

  const expectedMileage = asNumber(snapshot.Mileage ?? snapshot.mileageKm);
  const actualMileage = asNumber(spec.mileage);
  if (expectedMileage !== null && actualMileage !== null && expectedMileage !== actualMileage) {
    addMismatch(issues, "integrity_mileage_drift", "mileage_km", expectedMileage, actualMileage, "candidate_snapshot ↔ encar.detail.spec", "warning");
  }

  const expectedPrice = asNumber(snapshot.Price);
  const actualPrice = asNumber(advertisement.price);
  if (expectedPrice !== null && actualPrice !== null && expectedPrice !== actualPrice) {
    addMismatch(issues, "integrity_price_drift", "price", expectedPrice, actualPrice, "candidate_snapshot ↔ encar.detail.advertisement", "warning");
  }

  return issues;
}

export function validateQueueIdentity(identity: Pick<EnrichmentIdentity, "queueSourceListingId" | "queueSourceUrl" | "snapshot">): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const queueId = identity.queueSourceListingId.trim();
  const snapshotId = String(identity.snapshot.Id ?? "").trim();
  const urlCarId = identity.queueSourceUrl?.match(/[?&]carid=([^&#]+)/i)?.[1] ?? null;
  addMismatch(issues, "identity_snapshot_id_mismatch", "snapshot.Id", queueId, snapshotId, "queue.candidate_snapshot");
  if (urlCarId === null) {
    issues.push({ code: "identity_url_carid_missing", field: "source_url.carid", expected: queueId, actual: null, source: "queue.source_url" });
  } else {
    let decodedCarId = urlCarId;
    try { decodedCarId = decodeURIComponent(urlCarId); } catch { /* malformed values remain a mismatch */ }
    addMismatch(issues, "identity_url_carid_mismatch", "source_url.carid", queueId, decodedCarId, "queue.source_url");
  }
  return issues;
}

/** Refuse to overwrite any source ID already owned by staging or the catalog. */
export function validateExistingIdentityLinks(
  advertisedId: string,
  canonicalId: string,
  existing: ExistingIdentityRows,
): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const ids = new Set([advertisedId.trim(), canonicalId.trim()].filter(Boolean));
  for (const row of existing.staging) {
    if (!ids.has(row.source_listing_id)) continue;
    const payloadMatches = row.advertisedId === advertisedId && row.canonicalId === canonicalId;
    issues.push({
      code: payloadMatches ? "identity_existing_staging_duplicate" : "identity_existing_staging_conflict",
      field: "chestny_catalog_staging.source_listing_id",
      expected: { advertisedId, canonicalId },
      actual: { sourceListingId: row.source_listing_id, advertisedId: row.advertisedId ?? null, canonicalId: row.canonicalId ?? null },
      source: "supabase.chestny_catalog_staging",
    });
  }
  for (const row of existing.vehicles) {
    if (!ids.has(row.source_listing_id)) continue;
    issues.push({
      code: "identity_catalog_source_id_already_exists",
      field: "vehicles.source_listing_id",
      expected: "not present in catalog",
      actual: { vehicleId: row.id, sourceListingId: row.source_listing_id },
      source: "supabase.vehicles",
    });
  }
  for (const row of existing.sourceIdentifiers) {
    if (!ids.has(row.source_identifier)) continue;
    if (row.vehicle_source_listing_id && !ids.has(row.vehicle_source_listing_id)) {
      issues.push({
        code: "identity_source_identifier_vehicle_conflict",
        field: "vehicle_source_identifiers.vehicle_id",
        expected: { vehicleSourceListingId: canonicalId },
        actual: { sourceIdentifier: row.source_identifier, vehicleId: row.vehicle_id, vehicleSourceListingId: row.vehicle_source_listing_id },
        source: "supabase.vehicle_source_identifiers → vehicles",
      });
    }
    issues.push({
      code: "identity_source_identifier_already_linked",
      field: "vehicle_source_identifiers.source_identifier",
      expected: "not linked to an existing vehicle",
      actual: { sourceIdentifier: row.source_identifier, vehicleId: row.vehicle_id },
      source: "supabase.vehicle_source_identifiers",
    });
  }
  return issues;
}

/**
 * Confirms that queue, URL, snapshot, Encar detail, staging and existing
 * vehicle identifiers describe one listing. A canonical ID may differ from
 * the advertised listing ID; that relationship is preserved explicitly.
 */
export function validateEnrichmentIntegrity(identity: EnrichmentIdentity, bundle: EncarBundle): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const advertisedId = String(bundle.search.Id ?? "").trim();
  const queueId = identity.queueSourceListingId.trim();
  const detailCanonicalId = String(bundle.detail.vehicleId ?? "").trim();

  addMismatch(issues, "identity_search_id_mismatch", "search.Id", queueId, advertisedId, "encar.search");
  if (!detailCanonicalId) {
    issues.push({ code: "identity_canonical_id_missing", field: "detail.vehicleId", expected: "non-empty", actual: null, source: "encar.detail" });
  }
  if (identity.stagingSourceListingId !== undefined && identity.stagingSourceListingId !== null) {
    addMismatch(issues, "identity_staging_id_mismatch", "staging.source_listing_id", queueId, identity.stagingSourceListingId, "supabase.chestny_catalog_staging");
  }
  if (identity.vehicleSourceListingId !== undefined && identity.vehicleSourceListingId !== null) {
    addMismatch(issues, "identity_vehicle_id_mismatch", "vehicle.source_listing_id", queueId, identity.vehicleSourceListingId, "supabase.vehicles");
  }

  const identifiers = identity.linkedSourceIdentifiers ?? [];
  const conflictingLinks = identity.expectedVehicleId
    ? identifiers.filter((item) => item.value === queueId && item.vehicleId !== identity.expectedVehicleId)
    : [];
  if (conflictingLinks.length) {
    issues.push({
      code: "identity_source_identifier_collision",
      field: "vehicle_source_identifiers",
      expected: identity.expectedVehicleId,
      actual: conflictingLinks.map((item) => item.vehicleId),
      source: "supabase.vehicle_source_identifiers",
    });
  }

  const search = bundle.search as UnknownRecord;
  const detail = bundle.detail as UnknownRecord;
  const snapshot = identity.snapshot as UnknownRecord;
  const snapshotYear = modelYear(snapshot);
  const searchYear = modelYear(search);

  addMismatch(issues, "integrity_snapshot_manufacturer_mismatch", "manufacturer", snapshot.Manufacturer, search.Manufacturer, "encar.search");
  addMismatch(issues, "integrity_snapshot_model_mismatch", "model", snapshot.Model, search.Model, "encar.search");
  if (snapshotYear !== null && searchYear !== null) addMismatch(issues, "integrity_snapshot_year_mismatch", "model_year", snapshotYear, searchYear, "encar.search");
  const snapshotMileage = asNumber(snapshot.Mileage ?? snapshot.mileageKm);
  const searchMileage = asNumber(search.Mileage);
  if (snapshotMileage !== null && searchMileage !== null) addMismatch(issues, "integrity_snapshot_mileage_mismatch", "mileage_km", snapshotMileage, searchMileage, "encar.search");
  const snapshotPrice = priceKrw(snapshot);
  const searchPrice = priceKrw(search);
  if (snapshotPrice !== null && searchPrice !== null) addMismatch(issues, "integrity_snapshot_price_mismatch", "price", snapshotPrice, searchPrice, "encar.search");
  const detailAdvertised = String(detail.advertisementId ?? detail.advertisedVehicleId ?? "").trim();
  if (detailAdvertised) addMismatch(issues, "identity_detail_advertised_id_mismatch", "detail.advertisementId", queueId, detailAdvertised, "encar.detail");

  return issues;
}
