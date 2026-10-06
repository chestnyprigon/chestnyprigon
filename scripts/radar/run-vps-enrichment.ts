import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { accidentSummary, inspectionSummary } from "../encar/enrich";
import { encarHistoryHeaders, ensureEncarVerified } from "../encar/auth";
import { classifyEndpointProbe, isEndpointCircuitBreaker, shouldRetryEndpoint, type EncarEndpoint, type EndpointOutcome } from "../encar/endpoint-outcomes";
import { validateEnrichmentIntegrity, validateExistingIdentityLinks, validateQueueIdentity, validateSnapshotAgainstDetail } from "../encar/integrity";
import { screenListing } from "../encar/screening";
import type { EncarBundle, EncarSearchListing } from "../encar/types";
import { hasPendingEnrichment, isTerminalRun, TERMINAL_RUN_EXIT_CODE } from "./enrichment-run-state";

config({ path: ".env", quiet: true });
const direct = process.env.CHESTNY_ENRICHMENT_DIRECT === "true";
if (direct) config({ path: ".env.local", quiet: true });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function boundedNumber(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(raw) || raw < minimum || raw > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return raw;
}

const runId = required("CHESTNY_ENRICHMENT_RUN_ID");
const batchSize = boundedNumber("CHESTNY_ENRICHMENT_BATCH_SIZE", 50, 1, 50);
const delayMs = boundedNumber("CHESTNY_ENRICHMENT_DELAY_MS", 4_000, 1_000, 30_000);
const maxAttempts = boundedNumber("CHESTNY_ENRICHMENT_MAX_ATTEMPTS", 3, 1, 5);
const skipRetryRequeue = process.env.CHESTNY_ENRICHMENT_SKIP_RETRIES === "true";
const preserveRunStatus = process.env.CHESTNY_ENRICHMENT_PRESERVE_RUN_STATUS === "true";
const proxyUrl = direct ? null : required("ENCAR_PROXY_URL");
const coordinationDirectory = process.env.ENCAR_COORDINATION_DIR?.trim() || "/tmp/encar-coordination";
const activePath = `${coordinationDirectory}/chestny-enrichment-active.json`;
const radarPath = `${coordinationDirectory}/radar-priority.json`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value: unknown) => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
};
const scalar = (value: unknown, fallback: string | number | undefined) =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : fallback;
const obj = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : {};

type Row = {
  id: string;
  source_listing_id: string;
  source_url: string | null;
  candidate_snapshot: Record<string, unknown>;
};
type Db = ReturnType<typeof createClient<any>>;

class EncarRequestError extends Error {
  constructor(readonly status: number, readonly endpoint: string) {
    super(`HTTP ${status} for ${endpoint}`);
  }
}

async function radarHasPriority() {
  try {
    const owner = JSON.parse(await readFile(radarPath, "utf8")) as { pid?: number };
    if (!Number.isInteger(owner.pid)) return false;
    try { process.kill(owner.pid!, 0); return true; } catch { return false; }
  } catch { return false; }
}

function isRetryableFailure(error: string | null) {
  return Boolean(error && /fetch failed|abort|timeout|timed out|econn|eai_again|socket|proxy|HTTP (408|5\d\d)|endpoint_(options|inspection|insurance)_transient_error|detail_missing_canonical_identifier|identity_lookup_failed/i.test(error));
}

function failureClass(error: string) {
  if (/HTTP 401/i.test(error)) return "auth_error";
  if (/HTTP 403/i.test(error)) return "blocked";
  if (/HTTP 429/i.test(error)) return "rate_limited";
  if (/incomplete_gallery/i.test(error)) return "incomplete_gallery";
  if (/detail_missing_canonical_identifier/i.test(error)) return "canonical_identifier_missing";
  if (/HTTP (404|410)/i.test(error)) return "source_unavailable";
  if (/HTTP (408|429|5\d\d)|timeout|abort|proxy|socket|econn|eai_again|fetch failed/i.test(error)) return "transient_request";
  return "enrichment_error";
}

async function requestJson(agent: ProxyAgent | null, endpoint: string, headers?: Record<string, string>) {
  const response = await undiciFetch(endpoint, {
    headers: headers ?? {
      Accept: "application/json, text/plain, */*",
      Origin: "https://fem.encar.com",
      Referer: "https://fem.encar.com/",
    },
    ...(agent ? { dispatcher: agent } : {}),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new EncarRequestError(response.status, endpoint);
  return await response.json() as unknown;
}

async function requestJsonWithRetry(agent: ProxyAgent | null, endpoint: string) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await requestJson(agent, endpoint);
    } catch (error) {
      const status = error instanceof EncarRequestError ? error.status : null;
      const retryable = status === 408 || (status !== null && status >= 500)
        || /fetch failed|abort|timeout|timed out|econn|eai_again|socket|proxy/i.test(error instanceof Error ? error.message : String(error));
      if (!retryable || attempt === maxAttempts) throw error;
      await sleep(Math.min(delayMs * attempt, 30_000));
    }
  }
  throw new Error("detail_request_exhausted");
}

class EndpointEnrichmentError extends Error {
  constructor(readonly outcome: EndpointOutcome) {
    super(outcome.reasonCode);
  }
}

async function requestEndpoint(agent: ProxyAgent | null, name: EncarEndpoint, endpoint: string, canonicalId?: string, headers?: Record<string, string>) {
  let outcome: EndpointOutcome | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const payload = await requestJson(agent, endpoint, headers);
      outcome = classifyEndpointProbe({ endpoint: name, httpStatus: 200, payload, attempts: attempt, canonicalId });
    } catch (error) {
      const status = error instanceof EncarRequestError ? error.status : null;
      outcome = classifyEndpointProbe({ endpoint: name, httpStatus: status, error, attempts: attempt, canonicalId });
    }
    if (!shouldRetryEndpoint(outcome, attempt, maxAttempts)) break;
    await sleep(Math.min(delayMs * attempt, 30_000));
  }
  if (!outcome) throw new Error(`endpoint_${name}_no_result`);
  return outcome;
}

function assertEndpointNotBlocked(outcome: EndpointOutcome) {
  if (isEndpointCircuitBreaker(outcome)) throw new EndpointEnrichmentError(outcome);
}

function endpointStatus(outcome: EndpointOutcome | { endpoint: EncarEndpoint; state: "skipped"; reasonCode: string }) {
  return {
    state: outcome.state,
    httpStatus: "httpStatus" in outcome ? outcome.httpStatus : null,
    attempts: "attempts" in outcome ? outcome.attempts : 0,
    observedAt: "observedAt" in outcome ? outcome.observedAt : null,
    retryable: "retryable" in outcome ? outcome.retryable : false,
    reasonCode: outcome.reasonCode,
  };
}

async function requeueRetryableFailures(db: Db) {
  const { data, error } = await db.from("chestny_enrichment_queue")
    .select("id,last_error,attempt_count")
    .eq("run_id", runId)
    .eq("status", "failed")
    .lt("attempt_count", maxAttempts);
  if (error) throw new Error(error.message);
  const ids = ((data ?? []) as Array<{ id: string; last_error: string | null }>).filter((row) => isRetryableFailure(row.last_error)).map((row) => row.id);
  if (!ids.length) return 0;
  const { error: updateError } = await db.from("chestny_enrichment_queue")
    .update({ status: "queued", lease_until: null, updated_at: new Date().toISOString() })
    .in("id", ids);
  if (updateError) throw new Error(updateError.message);
  return ids.length;
}

async function complete(db: Db, row: Row, status: "succeeded" | "unavailable" | "failed", result: Record<string, unknown>, payload?: Record<string, unknown>, fuel?: string | null, color?: string | null, images: string[] = [], errorMessage?: string) {
  const response = await db.rpc("complete_chestny_enrichment_queue_item", {
    p_queue_id: row.id,
    p_status: status,
    p_result: result,
    p_payload: payload ?? null,
    p_fuel: fuel ?? null,
    p_color: color ?? null,
    p_image_urls: images,
    p_error: errorMessage ?? null,
  });
  if (response.error) throw new Error(response.error.message);
}

function photoUrls(detail: Record<string, unknown>) {
  const photos = Array.isArray(detail.photos) ? detail.photos : [];
  return [...new Set(photos.flatMap((photo) => {
    const path = text(obj(photo).path);
    if (!path) return [];
    return [path.startsWith("http") ? path : `https://ci.encar.com${path}`];
  }))].slice(0, 40);
}

function choiceOptions(payload: unknown) {
  if (!Array.isArray(payload)) return [];
  return payload.slice(0, 100).flatMap((item) => {
    const value = obj(item);
    const name = text(value.optionName);
    if (!name) return [];
    const price = Number(value.price);
    return [{ name, priceKrw: Number.isFinite(price) && price > 0 ? price * 10_000 : null, description: text(value.description) }];
  });
}

async function maybeFinishRun(db: Db) {
  if (await hasPendingEnrichment(db, runId)) return false;
  const { error: updateError } = await db.from("chestny_enrichment_runs").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", runId).in("status", ["approved", "running"]);
  if (updateError) throw new Error(updateError.message);
  return true;
}

async function main() {
  if (await radarHasPriority()) {
    console.log(JSON.stringify({ runId, deferred: "radar_priority" }));
    return;
  }
  const db: Db = createClient<any>(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: run, error: runError } = await db.from("chestny_enrichment_runs").select("status,candidate_count").eq("id", runId).single();
  if (runError) throw new Error(runError.message);
  if (isTerminalRun(run.status)) {
    console.log(JSON.stringify({ runId, status: run.status, skipped: "terminal_run" }));
    process.exitCode = TERMINAL_RUN_EXIT_CODE;
    return;
  }
  if (!["approved", "running"].includes(run.status)) throw new Error(`Run status is ${run.status}`);
  if (run.status === "approved" && !preserveRunStatus) {
    const { error } = await db.from("chestny_enrichment_runs").update({ status: "running", started_at: new Date().toISOString() }).eq("id", runId);
    if (error) throw new Error(error.message);
  }
  await mkdir(coordinationDirectory, { recursive: true });
  await writeFile(activePath, JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() }), { mode: 0o600 });
  const retriesScheduled = skipRetryRequeue ? 0 : await requeueRetryableFailures(db);
  const { data: rows, error } = await db.rpc("claim_chestny_enrichment_queue", { p_run_id: runId, p_limit: batchSize, p_lease_minutes: 45 });
  if (error) throw new Error(error.message);
  const agent = proxyUrl ? new ProxyAgent(proxyUrl) : null;
  const results: Array<Record<string, unknown>> = [];
  let pauseAfterCurrent = false;
  try {
    for (const [index, row] of (rows ?? []).entries() as Iterable<[number, Row]>) {
      if (pauseAfterCurrent) {
        const remaining = (rows as Row[]).slice(index).map((item) => item.id);
        if (remaining.length) {
          const { error: releaseError } = await db.from("chestny_enrichment_queue")
            .update({ status: "queued", lease_until: null, updated_at: new Date().toISOString() })
            .in("id", remaining).eq("status", "leased");
          if (releaseError) throw new Error(releaseError.message);
        }
        break;
      }
      if (await radarHasPriority()) {
        const remaining = (rows as Row[]).slice(index).map((item) => item.id);
        if (remaining.length) await db.from("chestny_enrichment_queue").update({ status: "queued", lease_until: null, updated_at: new Date().toISOString() }).in("id", remaining);
        break;
      }
      const advertisedId = row.source_listing_id;
      try {
        const queueIssues = validateQueueIdentity({
          queueSourceListingId: row.source_listing_id,
          queueSourceUrl: row.source_url,
          snapshot: row.candidate_snapshot as EncarSearchListing,
        });
        if (queueIssues.length) {
          const result = { advertisedId, failureClass: "identity_integrity", reasonCodes: queueIssues.map((issue) => issue.code), integrityIssues: queueIssues, retryable: false };
          await complete(db, row, "failed", result, undefined, undefined, undefined, [], "identity_integrity");
          results.push({ sourceListingId: advertisedId, status: "failed", ...result });
          continue;
        }
        // Resolve the canonical ID from detail before calling any other endpoint.
        const detailResponse = await requestJsonWithRetry(agent, `https://api.encar.com/v1/readside/vehicles?vehicleIds=${encodeURIComponent(advertisedId)}&include=SPEC,ADVERTISEMENT,PHOTOS,CATEGORY,MANAGE,CONTACT,VIEW,OPTIONS`);
        if (Array.isArray(detailResponse) && detailResponse.length !== 1) {
          const issue = {
            code: "identity_detail_response_cardinality",
            field: "detail.response_count",
            expected: 1,
            actual: detailResponse.length,
            source: "encar.detail",
          };
          const result = { advertisedId, failureClass: "identity_integrity", reasonCodes: [issue.code], integrityIssues: [issue], retryable: false };
          await complete(db, row, "failed", result, undefined, undefined, undefined, [], "identity_integrity");
          results.push({ sourceListingId: advertisedId, status: "failed", ...result });
          await sleep(delayMs);
          continue;
        }
        const detail = obj(Array.isArray(detailResponse) ? detailResponse[0] : detailResponse);
        const canonicalId = text(detail.vehicleId);
        const vehicleNo = text(detail.vehicleNo);
        if (!canonicalId || !vehicleNo) throw new Error("detail_missing_canonical_identifier");
        const advertisement = obj(detail.advertisement);
        const advertisementStatus = text(advertisement.status) ?? text(advertisement.saleStatus);
        if (advertisementStatus && !["ADVERTISE", "SALE"].includes(advertisementStatus)) {
          await complete(db, row, "unavailable", { advertisedId, canonicalId, vehicleNo, advertisementStatus });
          results.push({ sourceListingId: advertisedId, status: "unavailable", reason: advertisementStatus });
          await sleep(delayMs);
          continue;
        }
        const images = photoUrls(detail);
        const detailBundle: EncarBundle = {
          fetchedAt: new Date().toISOString(),
          search: row.candidate_snapshot as EncarSearchListing,
          detail: detail as EncarBundle["detail"],
        };
        const integrityIssues = [
          ...validateEnrichmentIntegrity({
            queueSourceListingId: row.source_listing_id,
            queueSourceUrl: row.source_url,
            snapshot: row.candidate_snapshot as EncarSearchListing,
          }, detailBundle),
          ...validateSnapshotAgainstDetail(row.candidate_snapshot as EncarSearchListing, detailBundle),
        ];
        const blockingIntegrityIssues = integrityIssues.filter((issue) => issue.severity !== "warning");
        if (blockingIntegrityIssues.length) {
          const result = {
            advertisedId,
            canonicalId,
            vehicleNo,
            failureClass: "identity_integrity",
            reasonCodes: blockingIntegrityIssues.map((issue) => issue.code),
            integrityIssues: blockingIntegrityIssues,
            retryable: false,
          };
          await complete(db, row, "failed", result, undefined, undefined, undefined, [], "identity_integrity");
          results.push({ sourceListingId: advertisedId, status: "failed", ...result });
          await sleep(delayMs);
          continue;
        }
        const candidateSearch = row.candidate_snapshot as EncarSearchListing;
        const currentSearch: EncarSearchListing = {
          ...candidateSearch,
          Manufacturer: text(obj(detail.category).manufacturerName) ?? candidateSearch.Manufacturer,
          Mileage: scalar(obj(detail.spec).mileage, candidateSearch.Mileage),
          Price: scalar(obj(detail.advertisement).price, candidateSearch.Price),
          FuelType: text(obj(detail.spec).fuelName) ?? candidateSearch.FuelType,
          Transmission: text(obj(detail.spec).transmissionName) ?? candidateSearch.Transmission,
        };
        const enrichedBundle: EncarBundle = { ...detailBundle, search: currentSearch };
        const identityIds = [...new Set([advertisedId, canonicalId])];
        const [stagingResult, vehicleResult, identifierResult] = await Promise.all([
          db.from("chestny_catalog_staging").select("source_listing_id,encar_payload").in("source_listing_id", identityIds),
          db.from("vehicles").select("id,source_listing_id").in("source_listing_id", identityIds),
          db.from("vehicle_source_identifiers").select("source_identifier,vehicle_id").in("source_identifier", identityIds),
        ]);
        if (stagingResult.error || vehicleResult.error || identifierResult.error) {
          const messages = [stagingResult.error, vehicleResult.error, identifierResult.error].filter(Boolean).map((error) => error!.message);
          throw new Error(`identity_lookup_failed:${messages.join("; ")}`);
        }
        const linkedVehicleIds = [...new Set((identifierResult.data ?? []).map((item: { vehicle_id: string }) => item.vehicle_id))];
        const linkedVehiclesResult = linkedVehicleIds.length
          ? await db.from("vehicles").select("id,source_listing_id").in("id", linkedVehicleIds)
          : { data: [], error: null };
        if (linkedVehiclesResult.error) throw new Error(`identity_lookup_failed:${linkedVehiclesResult.error.message}`);
        const sourceIdByVehicleId = new Map((linkedVehiclesResult.data ?? []).map((item: { id: string; source_listing_id: string }) => [item.id, item.source_listing_id]));
        const existingIssues = validateExistingIdentityLinks(advertisedId, canonicalId, {
          staging: (stagingResult.data ?? []).map((item: { source_listing_id: string; encar_payload: Record<string, unknown> | null }) => {
            const payload = obj(item.encar_payload);
            const identifiers = obj(payload.identifiers);
            return {
              source_listing_id: item.source_listing_id,
              advertisedId: text(identifiers.advertisedId),
              canonicalId: text(identifiers.canonicalId),
            };
          }),
          vehicles: (vehicleResult.data ?? []) as Array<{ id: string; source_listing_id: string }>,
          sourceIdentifiers: (identifierResult.data ?? []).map((item: { source_identifier: string; vehicle_id: string }) => ({
            ...item,
            vehicle_source_listing_id: sourceIdByVehicleId.get(item.vehicle_id) ?? null,
          })),
        });
        if (existingIssues.length) {
          const result = {
            advertisedId,
            canonicalId,
            vehicleNo,
            failureClass: "identity_integrity",
            reasonCodes: existingIssues.map((issue) => issue.code),
            integrityIssues: existingIssues,
            retryable: false,
          };
          await complete(db, row, "failed", result, undefined, undefined, undefined, [], "identity_integrity");
          results.push({ sourceListingId: advertisedId, status: "failed", ...result });
          await sleep(delayMs);
          continue;
        }
        const preliminaryScreening = screenListing(enrichedBundle);
        if (preliminaryScreening.decision !== "approved") {
          const skipped = "skipped_pre_screen";
          const spec = obj(detail.spec);
          const payload = {
            runId,
            detail,
            search: currentSearch,
            integrityWarnings: integrityIssues.filter((issue) => issue.severity === "warning"),
            choiceOptions: [],
            inspectionSummary: {},
            accidentSummary: {},
            rawReports: { inspection: null, diagnosis: null, insurance: null, history: null },
            identifiers: { advertisedId, canonicalId, vehicleNo },
            screening: preliminaryScreening,
            endpointStatus: { options: skipped, inspection: skipped, diagnosis: skipped, insurance: skipped, history: skipped },
            fetchedAt: new Date().toISOString(),
          };
          await complete(db, row, "succeeded", {
            advertisedId,
            canonicalId,
            vehicleNo,
            reportReady: false,
            reportState: "not_attempted",
            galleryImages: images.length,
            preliminaryScreening: preliminaryScreening.decision,
            reasonCodes: preliminaryScreening.reasonCodes,
          }, payload, text(spec.fuelName), text(spec.colorName), images);
          results.push({ sourceListingId: advertisedId, status: "succeeded", canonicalId, screenedOut: preliminaryScreening.decision, reasonCodes: preliminaryScreening.reasonCodes, supplementalRequests: 0 });
          await sleep(delayMs);
          continue;
        }
        // Encar is the only source. Keep supplemental calls serialized and
        // spaced just like candidate detail requests; do not burst four APIs.
        if (images.length < 5) throw new Error(`incomplete_gallery:${images.length}`);
        const optionsResult = await requestEndpoint(agent, "options", `https://api.encar.com/v1/readside/vehicles/car/${encodeURIComponent(canonicalId)}/options/choice`, canonicalId);
        assertEndpointNotBlocked(optionsResult);
        if (optionsResult.state === "confirmed_empty") {
          const spec = obj(detail.spec);
          const isolatedScreening = { ...preliminaryScreening, decision: "isolated" as const, reasonCodes: [...preliminaryScreening.reasonCodes, "options_confirmed_empty"] };
          const skipped = (endpoint: EncarEndpoint) => ({ endpoint, state: "skipped" as const, reasonCode: `${endpoint}_not_requested_after_options_isolation` });
          const payload = {
            runId,
            detail,
            search: currentSearch,
            integrityWarnings: integrityIssues.filter((issue) => issue.severity === "warning"),
            choiceOptions: [],
            inspectionSummary: {},
            accidentSummary: {},
            rawReports: { inspection: null, diagnosis: null, insurance: null, history: null },
            identifiers: { advertisedId, canonicalId, vehicleNo },
            screening: isolatedScreening,
            endpointStatus: {
              options: endpointStatus(optionsResult),
              inspection: endpointStatus(skipped("inspection")),
              diagnosis: endpointStatus(skipped("diagnosis")),
              insurance: endpointStatus(skipped("insurance")),
              history: endpointStatus(skipped("history")),
            },
            fetchedAt: new Date().toISOString(),
          };
          await complete(db, row, "succeeded", {
            advertisedId, canonicalId, vehicleNo, reportReady: false,
            reportState: "not_attempted", screeningDecision: "isolated",
            reasonCodes: isolatedScreening.reasonCodes, galleryImages: images.length,
          }, payload, text(spec.fuelName), text(spec.colorName), images);
          results.push({ sourceListingId: advertisedId, status: "succeeded", canonicalId, screenedOut: "isolated", reasonCodes: isolatedScreening.reasonCodes, optionsState: optionsResult.state, supplementalRequests: 1 });
          await sleep(delayMs);
          continue;
        }
        if (optionsResult.state !== "ok") throw new EndpointEnrichmentError(optionsResult);
        await sleep(delayMs);
        const inspectionResult = await requestEndpoint(agent, "inspection", `https://api.encar.com/v1/readside/inspection/vehicle/${encodeURIComponent(canonicalId)}`, canonicalId);
        assertEndpointNotBlocked(inspectionResult);
        await sleep(delayMs);
        const diagnosisResult = await requestEndpoint(agent, "diagnosis", `https://api.encar.com/v1/readside/diagnosis/vehicle/${encodeURIComponent(canonicalId)}`, canonicalId);
        assertEndpointNotBlocked(diagnosisResult);
        if (diagnosisResult.state === "identity_mismatch") throw new EndpointEnrichmentError(diagnosisResult);
        await sleep(delayMs);
        const insuranceResult = await requestEndpoint(agent, "insurance", `https://api.encar.com/v1/readside/record/vehicle/${encodeURIComponent(canonicalId)}/open?vehicleNo=${encodeURIComponent(vehicleNo)}`, canonicalId);
        assertEndpointNotBlocked(insuranceResult);
        await sleep(delayMs);
        let historyResult: EndpointOutcome = {
          endpoint: "history", state: "skipped", httpStatus: null, attempts: 0,
          observedAt: new Date().toISOString(), retryable: false, payload: null,
          reasonCode: "history_not_requested",
        };
        let historyVerificationFailed = false;
        try {
          if (direct) await ensureEncarVerified();
        } catch (error) {
          historyVerificationFailed = true;
          historyResult = classifyEndpointProbe({ endpoint: "history", error });
          assertEndpointNotBlocked(historyResult);
        }
        if (historyVerificationFailed) throw new EndpointEnrichmentError(historyResult);
        if (!historyVerificationFailed) {
          const historyAvailability = await requestEndpoint(agent, "history_availability", `https://api.encar.com/v1/vehicle/resume/valid?vehicleNo=${encodeURIComponent(vehicleNo)}`, canonicalId, encarHistoryHeaders());
          assertEndpointNotBlocked(historyAvailability);
          if (historyAvailability.state === "confirmed_unavailable") {
            historyResult = {
              ...historyAvailability,
              endpoint: "history",
              reasonCode: "history_confirmed_unavailable",
            };
          } else if (historyAvailability.state === "ok") {
            await sleep(delayMs);
            historyResult = await requestEndpoint(agent, "history", `https://api.encar.com/v1/vehicle/resume?vehicleNo=${encodeURIComponent(vehicleNo)}`, canonicalId, encarHistoryHeaders());
            assertEndpointNotBlocked(historyResult);
          } else {
            historyResult = {
              ...historyAvailability,
              endpoint: "history",
              reasonCode: `history_availability_${historyAvailability.state}`,
            };
          }
        }
        const criticalOutcomes = [optionsResult, inspectionResult, insuranceResult];
        if (optionsResult.state !== "ok" && optionsResult.state !== "confirmed_empty") {
          throw new EndpointEnrichmentError(optionsResult);
        }
        if ([inspectionResult, insuranceResult].some((result) => !["ok", "not_found", "confirmed_unavailable"].includes(result.state))) {
          const unresolved = [inspectionResult, insuranceResult].find((result) => !["ok", "not_found", "confirmed_unavailable"].includes(result.state))!;
          throw new EndpointEnrichmentError(unresolved);
        }
        const inspection = inspectionResult.state === "ok" ? inspectionResult.payload : null;
        const insurance = insuranceResult.state === "ok" || insuranceResult.state === "confirmed_unavailable" ? insuranceResult.payload : null;
        const history = historyResult.state === "ok" ? historyResult.payload : null;
        const optionsPayload = optionsResult.state === "ok" ? optionsResult.payload : [];
        // Detail and a usable gallery are required for successful staging.
        // A missing report remains a visible status, not a hard reject.
        const diagnosisAvailable = diagnosisResult.state === "ok"
          ? true
          : ["not_found", "confirmed_unavailable"].includes(diagnosisResult.state) ? false : null;
        const diagnosis = diagnosisResult.state === "ok" ? diagnosisResult.payload : null;
        const inspectionData = inspectionSummary(inspection, enrichedBundle, diagnosis, diagnosisAvailable);
        const accidents = accidentSummary(insurance, history);
        const reportReady = inspectionResult.state === "ok" && Number(obj(inspection).vehicleId) === Number(canonicalId) && insuranceResult.state === "ok";
        const spec = obj(detail.spec);
        const supplementalDecision = preliminaryScreening;
        const payload = {
          runId,
          detail,
          search: currentSearch,
          integrityWarnings: integrityIssues.filter((issue) => issue.severity === "warning"),
          choiceOptions: choiceOptions(optionsPayload),
          inspectionSummary: inspectionData,
          accidentSummary: accidents,
          rawReports: { inspection, diagnosis, insurance, history },
          identifiers: { advertisedId, canonicalId, vehicleNo },
          screening: supplementalDecision,
          endpointStatus: {
            options: endpointStatus(optionsResult),
            inspection: endpointStatus(inspectionResult),
            diagnosis: endpointStatus(diagnosisResult),
            insurance: endpointStatus(insuranceResult),
            history: endpointStatus(historyResult),
          },
          fetchedAt: new Date().toISOString(),
        };
        await complete(db, row, "succeeded", {
          advertisedId,
          canonicalId,
          vehicleNo,
          inspectionAvailable: Boolean(inspection),
          reportReady,
          reportState: reportReady ? "ready" : "confirmed_unavailable",
          screeningDecision: supplementalDecision.decision,
          reasonCodes: supplementalDecision.reasonCodes,
          galleryImages: images.length,
          accidentCount: accidents.accidentCount,
        }, payload, text(spec.fuelName), text(spec.colorName), images);
        results.push({ sourceListingId: advertisedId, status: "succeeded", canonicalId, reportReady, optionsState: optionsResult.state, historyState: historyResult.state, galleryImages: images.length, accidentCount: accidents.accidentCount });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unavailable = error instanceof EncarRequestError && [404, 410].includes(error.status);
        const kind = failureClass(message);
        const endpointOutcome = error instanceof EndpointEnrichmentError ? error.outcome : null;
        const retryable = !unavailable && (endpointOutcome?.retryable ?? isRetryableFailure(message));
        const stopState = (endpointOutcome && (isEndpointCircuitBreaker(endpointOutcome)
          || endpointOutcome.state === "transient_error"
          || endpointOutcome.state === "auth_error"))
          || ["transient_request", "auth_error", "blocked", "rate_limited"].includes(kind);
        if (stopState) pauseAfterCurrent = true;
        const reportedError = endpointOutcome?.httpStatus ? `HTTP ${endpointOutcome.httpStatus}` : endpointOutcome?.reasonCode ?? message;
        await complete(db, row, unavailable ? "unavailable" : "failed", {
          advertisedId,
          reason: endpointOutcome?.reasonCode ?? message,
          ...(endpointOutcome ? { endpointStatus: endpointStatus(endpointOutcome), reasonCodes: [endpointOutcome.reasonCode] } : {}),
          failureClass: endpointOutcome ? `endpoint_${endpointOutcome.state}` : kind,
          retryable,
        }, undefined, undefined, undefined, [], unavailable ? undefined : (endpointOutcome?.reasonCode ?? message));
        results.push({ sourceListingId: advertisedId, status: unavailable ? "unavailable" : "failed", error: reportedError, reasonCode: endpointOutcome?.reasonCode, failureClass: endpointOutcome ? `endpoint_${endpointOutcome.state}` : kind, retryable });
      }
      await sleep(delayMs);
    }
    const completed = preserveRunStatus ? false : await maybeFinishRun(db);
    console.log(JSON.stringify({ runId, transport: direct ? "direct" : "proxy", batchSize, retriesScheduled, claimed: rows?.length ?? 0, succeeded: results.filter((r) => r.status === "succeeded").length, unavailable: results.filter((r) => r.status === "unavailable").length, failed: results.filter((r) => r.status === "failed").length, completed, results }, null, 2));
  } finally {
    await agent?.close();
    await rm(activePath, { force: true });
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
