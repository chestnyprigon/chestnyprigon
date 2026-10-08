import type { EncarBundle, EncarSearchListing, NormalizedVehicle, ScreeningResult } from "./types";
import { CATALOG_POLICY, evidence, type DecisionEvidence } from "./catalog-policy";
import { validateQueueIdentity, validateSnapshotAgainstDetail, type IntegrityIssue } from "./integrity";
import { normalizeListing } from "./normalize";
import { screenListing } from "./screening";
import { classifyEndpointProbe, type EncarEndpoint } from "./endpoint-outcomes";

const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

export function isolate(screening: ScreeningResult, reasons: DecisionEvidence[]): ScreeningResult {
  return { ...screening, decision: "isolated", isProblematic: true,
    reasonCodes: [...new Set([...screening.reasonCodes, ...reasons.map(r => r.code)])],
    reasonEvidence: [...screening.reasonEvidence, ...reasons] };
}

export function integrityEvidence(issues: IntegrityIssue[]): DecisionEvidence[] {
  return issues.filter(issue => issue.severity !== "warning").map(issue => evidence(issue.code,
    `Не подтверждена связность данных: ${issue.field}.`, { expected: issue.expected, actual: issue.actual }, issue.source));
}

function photoKey(value: string) {
  try {
    const url = new URL(value.startsWith("/") ? `https://ci.encar.com${value}` : value);
    return url.hostname === "ci.encar.com" ? url.pathname : null;
  } catch { return null; }
}

export function validateGallery(bundle: EncarBundle, images?: unknown[]): DecisionEvidence[] {
  const allowed = new Set([String(bundle.search.Id), String(bundle.detail.vehicleId)]);
  const paths = (bundle.detail.photos ?? []).map(photo => String(photo.path ?? "")).filter(Boolean);
  const reasons: DecisionEvidence[] = [];
  for (const path of paths) {
    const key = photoKey(path);
    const owner = key?.match(/\/(\d+)_\d+\.(?:jpg|jpeg|png|webp)$/i)?.[1];
    if (!key || !owner || !allowed.has(owner)) reasons.push(evidence(owner ? "photo_identity_mismatch" : "photo_identity_unconfirmed",
      "Принадлежность фотографии ожидаемому объявлению не подтверждена.", { path, owner: owner ?? null, allowedIds: [...allowed] }, "encar.detail.photos"));
  }
  if (images) {
    const keys = new Set(paths.map(photoKey).filter(Boolean));
    for (const image of images) if (!keys.has(photoKey(String(image)))) reasons.push(evidence("staging_gallery_mismatch",
      "Фотография staging отсутствует в исходной галерее detail.", { image }, "staging.image_urls ↔ encar.detail.photos"));
    if (new Set(images.map(image => photoKey(String(image))).filter(Boolean)).size < CATALOG_POLICY.minImages) reasons.push(evidence("insufficient_staging_photos",
      "В staging меньше пяти уникальных фотографий.", { count: images.length, minimum: CATALOG_POLICY.minImages }, "staging.image_urls"));
  }
  return reasons;
}

export type PublicationInput = {
  bundle: EncarBundle;
  sourceUrl: string;
  snapshot?: EncarSearchListing;
  identifiers?: Record<string, unknown>;
  images?: unknown[];
  endpointStatus?: Record<string, unknown>;
  rawReports?: Record<string, unknown>;
  options?: unknown;
  expectedVehicle?: Partial<NormalizedVehicle>;
  queueId?: string;
};

/** Re-evaluates the source, never trusts a saved "approved" or overwritten search ID. */
export function publicationGate(input: PublicationInput) {
  const { bundle } = input;
  let screening = screenListing(bundle);
  const reasons = integrityEvidence([
    ...validateQueueIdentity({ queueSourceListingId: input.queueId ?? String(bundle.search.Id), queueSourceUrl: input.sourceUrl, snapshot: input.snapshot ?? bundle.search }),
    ...validateSnapshotAgainstDetail(input.snapshot ?? bundle.search, bundle),
  ]);
  const canonicalId = String(bundle.detail.vehicleId ?? "");
  if (!canonicalId || !bundle.detail.vehicleNo) reasons.push(evidence("canonical_identifier_missing", "Отсутствует canonical ID или регистрационный номер.", { canonicalId, vehicleNo: bundle.detail.vehicleNo ?? null }, "encar.detail"));
  if (input.identifiers) for (const [key, actual] of Object.entries({ advertisedId: String(bundle.search.Id), canonicalId, vehicleNo: bundle.detail.vehicleNo })) {
    if (String(input.identifiers[key] ?? "") !== String(actual ?? "")) reasons.push(evidence("payload_identifier_mismatch", "Сохранённая связка ID не соответствует исходному payload.", { key, expected: actual, actual: input.identifiers[key] ?? null }, "staging.identifiers ↔ encar.detail/search"));
  }
  reasons.push(...validateGallery(bundle, input.images));
  const modifiedAt = Date.parse(String(obj(bundle.detail.manage).modifyDateTime ?? ""));
  if (!Number.isFinite(modifiedAt)) reasons.push(evidence("listing_freshness_unconfirmed", "Источник не передал дату актуальности.", { modifiedAt: obj(bundle.detail.manage).modifyDateTime ?? null }, "encar.detail.manage"));
  else if (Date.now() - modifiedAt > CATALOG_POLICY.maxListingAgeDays * 86400000) {
    const r = evidence("stale_listing", "Объявление старше согласованных 180 дней.", { modifiedAt: new Date(modifiedAt).toISOString(), maxDays: CATALOG_POLICY.maxListingAgeDays }, "encar.detail.manage");
    screening = { ...screening, decision: "rejected", reasonCodes: [...screening.reasonCodes, r.code], reasonEvidence: [...screening.reasonEvidence, r] };
  }
  const statuses = input.endpointStatus ?? {};
  const reports = input.rawReports ?? {};
  const resultStates: Record<string, string> = {};
  for (const name of ["options", "inspection", "diagnosis", "insurance", "history"] as EncarEndpoint[]) {
    const stored = statuses[name];
    let state = typeof stored === "string" ? stored : String(obj(stored).state ?? "not_attempted");
    const payload = name === "options" ? input.options : reports[name];
    const provenance = obj(stored);
    if (screening.decision !== "rejected" && name !== "history" && provenance.requestedCanonicalId !== canonicalId) reasons.push(evidence(`${name}_provenance_unconfirmed`,
      "Не подтверждён canonical ID, для которого запрашивался этот блок.", { expected: canonicalId, actual: provenance.requestedCanonicalId ?? null }, `endpointStatus.${name}`));
    if (screening.decision !== "rejected" && name === "insurance" && provenance.requestedVehicleNo !== bundle.detail.vehicleNo) reasons.push(evidence("insurance_vehicle_number_unconfirmed",
      "Страховой запрос не связан с регистрационным номером исходной карточки.", { expected: bundle.detail.vehicleNo, actual: provenance.requestedVehicleNo ?? null }, "endpointStatus.insurance"));
    if (payload !== null && payload !== undefined) {
      const actual = classifyEndpointProbe({ endpoint: name, httpStatus: 200, payload, canonicalId, vehicleNo: bundle.detail.vehicleNo });
      state = actual.state;
    } else if (state === "ok") state = "invalid_payload";
    resultStates[name] = state;
    const acceptable = name === "options" ? ["ok"] : ["ok", "not_found", "confirmed_unavailable", "confirmed_empty"];
    // Resume history is supplementary, but its ID can never conflict.
    if (state === "identity_mismatch" || (screening.decision !== "rejected" && name !== "history" && !acceptable.includes(state))) reasons.push(evidence(`${name}_${state}`,
      state === "confirmed_empty" ? "Источник подтвердил отсутствие обязательных опций." : "Блок обогащения не получен достоверно; публикация изолирована до автоматического повтора.",
      { endpoint: name, state, storedStatus: stored ?? null }, `encar.${name}`));
    if (["not_found", "confirmed_unavailable", "confirmed_empty"].includes(state) && name !== "options") {
      screening.reasonEvidence.push(evidence(`${name}_${state}`, "Источник подтвердил отсутствие необязательного отчёта; это не отказ.", { endpoint: name, state }, `encar.${name}`));
    }
  }
  const normalized = normalizeListing(bundle);
  if (!normalized.engineCc || !normalized.fuelType || normalized.fuelType === "Не указано") reasons.push(evidence("pricing_characteristics_missing", "Нет обязательных характеристик для расчёта стоимости.", { engineCc: normalized.engineCc, fuelType: normalized.fuelType }, "encar.detail.spec/category"));
  if (input.expectedVehicle) for (const [key, actual] of Object.entries(input.expectedVehicle)) {
    const expected = normalized[key as keyof NormalizedVehicle];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) reasons.push(evidence("normalized_field_mismatch", "Сохранённая карточка расходится с исходными данными.", { field: key, expected, actual }, "normalized vehicle ↔ Encar payload"));
  }
  const inspection = obj(reports.inspection);
  const changes = obj(obj(inspection.master).detail).usageChangeTypes ?? inspection.usageChangeTypes;
  const usage = Array.isArray(changes) ? changes.map(value => typeof value === "string" ? value : String(obj(value).title ?? "")).join(" ") : "";
  if (/렌트|대여|택시|영업|화물|commercial|rental|taxi/i.test(usage)) {
    const r = evidence("inspection_usage_excluded", "Инспекционный отчёт подтвердил запрещённое использование.", { usage }, "encar.inspection.usageChangeTypes");
    screening = { ...screening, decision: "rejected", reasonCodes: [...screening.reasonCodes, r.code], reasonEvidence: [...screening.reasonEvidence, r] };
  }
  if (reasons.length) screening = isolate(screening, reasons);
  const reportStatus = ["inspection", "insurance"].every(name => resultStates[name] === "ok") ? "ready" :
    ["inspection", "insurance"].every(name => ["ok", "not_found", "confirmed_unavailable"].includes(resultStates[name])) ? "unavailable" : null;
  return { screening, normalized, reportStatus, proof: { validated: screening.decision === "approved", version: CATALOG_POLICY.version,
    advertisedId: String(bundle.search.Id), canonicalId, checkedAt: new Date().toISOString(), endpointStates: resultStates,
    normalized: { manufacturer: normalized.manufacturer, model: normalized.model, modelYear: normalized.modelYear, mileageKm: normalized.mileageKm,
      engineCc: normalized.engineCc, fuelType: normalized.fuelType, transmission: normalized.transmission, priceKrw: normalized.priceKrw } } };
}
