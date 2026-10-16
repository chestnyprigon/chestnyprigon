import { normalizeListing } from "../encar/normalize";
import { resolveEquipment } from "../encar/equipment-resolution";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { get as httpsGet } from "node:https";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { accidentSummary, inspectionSummary } from "../encar/enrich";
import { encarHistoryHeaders, ensureEncarVerified } from "../encar/auth";
import { classifyEndpointProbe, isEndpointCircuitBreaker, shouldRetryEndpoint, type EncarEndpoint, type EndpointOutcome } from "../encar/endpoint-outcomes";
import { isVerifiedSameCanonicalRefreshSibling, validateEnrichmentIntegrity, validateExistingIdentityLinks, validateQueueIdentity, validateSnapshotAgainstDetail } from "../encar/integrity";
import { requestEndpointWithRetry } from "../encar/endpoint-retry";
import { screenListing } from "../encar/screening";
import { integrityEvidence, isolate, publicationGate, validateGallery } from "../encar/publication-gate";
import { CATALOG_POLICY, evidence } from "../encar/catalog-policy";
import type { EncarBundle, EncarSearchListing } from "../encar/types";
import { hasPendingEnrichment, isTerminalRun, TERMINAL_RUN_EXIT_CODE } from "./enrichment-run-state";
import { withEnrichmentWorkerLock } from "./enrichment-worker-lock";

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
const waveId = process.env.CHESTNY_ENRICHMENT_WAVE_ID?.trim() || null;
if (waveId && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(waveId)) throw new Error("CHESTNY_ENRICHMENT_WAVE_ID must be a wave UUID");
const standardLocalRun = process.env.CHESTNY_ENRICHMENT_STANDARD_RUN === "true";
const batchSize = boundedNumber("CHESTNY_ENRICHMENT_BATCH_SIZE", direct ? 1 : 50, 1, direct ? 10 : 50);
const delayMs = boundedNumber("CHESTNY_ENRICHMENT_DELAY_MS", CATALOG_POLICY.requestDelayMs, 1_000, 30_000);
const maxAttempts = boundedNumber("CHESTNY_ENRICHMENT_MAX_ATTEMPTS", CATALOG_POLICY.maxEndpointAttempts, 1, CATALOG_POLICY.maxEndpointAttempts);
const skipRetryRequeue = process.env.CHESTNY_ENRICHMENT_SKIP_RETRIES !== "false";
const preserveRunStatus = process.env.CHESTNY_ENRICHMENT_PRESERVE_RUN_STATUS === "true";
const proxyUrl = direct ? null : required("ENCAR_PROXY_URL");
const coordinationDirectory = process.env.ENCAR_COORDINATION_DIR?.trim() || "/tmp/encar-coordination";
const activePath = process.env.CHESTNY_ENRICHMENT_ACTIVE_PATH?.trim() || `${coordinationDirectory}/chestny-enrichment-active.json`;
const radarPath = `${coordinationDirectory}/radar-priority.json`;

const startedAt = Date.now();
let requestedJson = 0;
let scheduledWaitMs = 0;
const sleep = (ms: number) => { scheduledWaitMs += ms; return new Promise((resolve) => setTimeout(resolve, ms)); };
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
  attempt_count?: number;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- The generated Supabase schema does not include the worker tables yet.
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
  if (/HTTP (401|407)/i.test(error)) return "auth_error";
  if (/HTTP 403/i.test(error)) return "blocked";
  if (/HTTP 429/i.test(error)) return "rate_limited";
  if (/incomplete_gallery/i.test(error)) return "incomplete_gallery";
  if (/detail_missing_canonical_identifier/i.test(error)) return "canonical_identifier_missing";
  if (/detail_empty_response/i.test(error)) return "source_unavailable";
  if (/HTTP (404|410)/i.test(error)) return "source_unavailable";
  if (/HTTP (408|429|5\d\d)|timeout|abort|proxy|socket|econn|eai_again|fetch failed/i.test(error)) return "transient_request";
  return "enrichment_error";
}

function failureReasonCode(error: string, kind: string) {
  if (/detail_empty_response/i.test(error) || /HTTP (404|410)/i.test(error)) return "source_listing_unavailable";
  if (/HTTP (401|407)/i.test(error)) return "source_authentication_error";
  if (/HTTP 403/i.test(error)) return "source_access_blocked";
  if (/HTTP 429/i.test(error)) return "source_rate_limited";
  if (/incomplete_gallery/i.test(error)) return "gallery_incomplete";
  if (/identity|canonical/i.test(error)) return "identity_integrity_failed";
  if (/fetch failed|abort|timeout|timed out|econn|eai_again|socket|proxy|HTTP (408|5\d\d)/i.test(error)) return "temporary_network_error";
  return kind;
}

async function requestJson(agent: ProxyAgent | null, endpoint: string, headers?: Record<string, string>, lockSignal?: AbortSignal) {
  requestedJson += 1;
  // Use the native HTTPS client for direct requests; preserve source HTTP
  // statuses instead of Fetch's opaque network error on HTTP 407.
  if (!agent) {
    return await new Promise<unknown>((resolve, reject) => {
      const signal = lockSignal ? AbortSignal.any([AbortSignal.timeout(25_000), lockSignal]) : AbortSignal.timeout(25_000);
      const request = httpsGet(endpoint, { headers: headers ?? { Accept: "application/json" }, signal }, (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new EncarRequestError(status, endpoint));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 10 * 1024 * 1024) { response.destroy(new Error("JSON response exceeds 10 MB")); return; }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch (error) { reject(error); }
        });
      });
      request.on("error", reject);
    });
  }
  const response = await undiciFetch(endpoint, {
    headers: headers ?? {
      Accept: "application/json, text/plain, */*",
      Origin: "https://fem.encar.com",
      Referer: "https://fem.encar.com/",
    },
    ...(agent ? { dispatcher: agent } : {}),
    signal: lockSignal ? AbortSignal.any([AbortSignal.timeout(25_000), lockSignal]) : AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new EncarRequestError(response.status, endpoint);
  return await response.json() as unknown;
}

async function requestJsonWithRetry(agent: ProxyAgent | null, endpoint: string, lockSignal?: AbortSignal) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (lockSignal?.aborted) throw lockSignal.reason;
      return await requestJson(agent, endpoint, undefined, lockSignal);
    } catch (error) {
      if (lockSignal?.aborted) throw lockSignal.reason ?? error;
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

async function requestEndpoint(agent: ProxyAgent | null, name: EncarEndpoint, endpoint: string, canonicalId?: string, headers?: Record<string, string>, lockSignal?: AbortSignal) {
  const outcome = await requestEndpointWithRetry({ endpoint: name, canonicalId, signal: lockSignal,
    vehicleNo: new URL(endpoint).searchParams.get("vehicleNo") ?? undefined,
    maxAttempts, delayMs, wait: sleep,
    probe: async () => {
      if (lockSignal?.aborted) throw lockSignal.reason;
      try { return { httpStatus: 200, payload: await requestJson(agent, endpoint, headers, lockSignal) }; }
      catch (error) { if (lockSignal?.aborted) throw lockSignal.reason ?? error; return { httpStatus: error instanceof EncarRequestError ? error.status : null, error }; }
    },
  });
  if (lockSignal?.aborted) throw lockSignal.reason;
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
    requestedCanonicalId: "requestedCanonicalId" in outcome ? outcome.requestedCanonicalId : null,
    requestedVehicleNo: "requestedVehicleNo" in outcome ? outcome.requestedVehicleNo : null,
    errorMessage: "errorMessage" in outcome ? outcome.errorMessage : null,
  };
}

async function requeueRetryableFailures(db: Db, scopeWaveId = waveId) {
  let query = db.from("chestny_enrichment_queue")
    .select("id,last_error,attempt_count,result")
    .eq("run_id", runId)
    .eq("status", "failed")
    .lt("attempt_count", maxAttempts);
  if (scopeWaveId) query = query.eq("wave_id", scopeWaveId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const ids = ((data ?? []) as Array<{ id: string; last_error: string | null; result?: Record<string, unknown> }>).filter((row) => row.last_error !== "detail_empty_response" && (row.result?.retryable === true || (row.result?.retryExhausted !== true && isRetryableFailure(row.last_error))) && (!row.result?.retryAfter || Date.parse(String(row.result.retryAfter)) <= Date.now())).map((row) => row.id);
  if (!ids.length) return 0;
  const { error: updateError } = await db.from("chestny_enrichment_queue")
    .update({ status: "queued", lease_until: null, updated_at: new Date().toISOString() })
    .in("id", ids);
  if (updateError) throw new Error(updateError.message);
  return ids.length;
}

async function complete(db: Db, row: Row, status: "succeeded" | "unavailable" | "failed", result: Record<string, unknown>, payload?: Record<string, unknown>, fuel?: string | null, color?: string | null, images: string[] = [], errorMessage?: string) {
  if (result.failureClass === "identity_integrity") {
    result.screeningDecision = "isolated";
    result.reasonEvidence = integrityEvidence(result.integrityIssues as Parameters<typeof integrityEvidence>[0]);
  }
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

async function pendingRetries(db: Db) {
  if (skipRetryRequeue) return 0;
  let query = db.from("chestny_enrichment_queue").select("id,result")
    .eq("run_id", runId).eq("status", "failed").lt("attempt_count", maxAttempts);
  if (waveId) query = query.eq("wave_id", waveId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).filter((row: { result?: Record<string, unknown> }) => row.result?.retryable === true).length;
}

async function maybeFinishRun(db: Db) {
  if (await hasPendingEnrichment(db, runId) || await pendingRetries(db)) return false;
  const { data: waves, error: waveError } = await db.from("chestny_enrichment_waves")
    .select("status").eq("run_id", runId);
  if (waveError) throw new Error(`Could not verify wave completion: ${waveError.message}`);
  if ((waves ?? []).some((wave: { status: string }) => !["ready", "completed"].includes(wave.status))) return false;
  const { error: updateError } = await db.from("chestny_enrichment_runs").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", runId).in("status", ["approved", "running"]);
  if (updateError) throw new Error(updateError.message);
  return true;
}

async function processBatch(db: Db, lockSignal: AbortSignal) {
  if (await radarHasPriority()) {
    console.log(JSON.stringify({ runId, deferred: "radar_priority" }));
    return;
  }
  const { data: run, error: runError } = await db.from("chestny_enrichment_runs").select("status,candidate_count,rules").eq("id", runId).single();
  if (runError) throw new Error(runError.message);
  if (waveId) {
    const { data: wave, error: waveError } = await db.from("chestny_enrichment_waves")
      .select("id,status").eq("id", waveId).eq("run_id", runId).single();
    if (waveError) throw new Error(`Cannot resolve wave ${waveId} for run ${runId}: ${waveError.message}`);
    if (!(["queued", "enriching", "paused"] as string[]).includes(wave.status)) throw new Error(`Wave ${waveId} is ${wave.status}, not open for enrichment`);
  }
  if (standardLocalRun && run.rules?.catalogLaunchId) throw new Error("Ordinary local batching cannot process a separate catalog launch");
  const allowMatchingStagingRefresh = process.env.CHESTNY_ENRICHMENT_ALLOW_MATCHING_STAGING_REFRESH === "true";
  if (allowMatchingStagingRefresh && run.rules?.type !== "targeted_report_refresh") {
    throw new Error("Matching staging refresh is only allowed for a targeted_report_refresh run");
  }
  const allowVerifiedCanonicalSibling = allowMatchingStagingRefresh
    && run.rules?.allowVerifiedCanonicalSibling === true
    && typeof run.rules?.sourceRunId === "string";
  if (run.rules?.allowVerifiedCanonicalSibling === true && !allowVerifiedCanonicalSibling) {
    throw new Error("Verified canonical sibling handling requires a targeted report refresh and sourceRunId");
  }
  const targetedRefreshPacing = allowMatchingStagingRefresh && run.rules?.type === "targeted_report_refresh";
  const minimumDelayMs = targetedRefreshPacing ? 2_000 : CATALOG_POLICY.requestDelayMs;
  if (delayMs < minimumDelayMs) {
    throw new Error(`CHESTNY_ENRICHMENT_DELAY_MS must be at least ${minimumDelayMs}ms for this run`);
  }
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
  const retriesScheduled = skipRetryRequeue ? 0 : await requeueRetryableFailures(db);
  if (lockSignal.aborted) throw lockSignal.reason;
  const claim = waveId
    ? await db.rpc("claim_chestny_enrichment_wave", { p_run_id: runId, p_wave_id: waveId, p_limit: batchSize, p_lease_minutes: 15 })
    : await db.rpc("claim_chestny_enrichment_queue", { p_run_id: runId, p_limit: batchSize, p_lease_minutes: 15 });
  const { data: rows, error } = claim;
  if (error) throw new Error(error.message);
  await mkdir(coordinationDirectory, { recursive: true });
  try {
    await writeFile(activePath, JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() }), { mode: 0o600 });
  } catch (writeError) {
    const claimedIds = ((rows ?? []) as Row[]).map((row) => row.id);
    if (claimedIds.length) await db.from("chestny_enrichment_queue").update({ status: "queued", lease_until: null, updated_at: new Date().toISOString() }).in("id", claimedIds).eq("status", "leased");
    throw writeError;
  }
  const agent = proxyUrl ? new ProxyAgent(proxyUrl) : null;
  const results: Array<Record<string, unknown>> = [];
  let pauseAfterCurrent = false;
  let pauseMessage = "";
  try {
    for (const [index, row] of (rows ?? []).entries() as Iterable<[number, Row]>) {
      if (lockSignal.aborted) {
        await db.from("chestny_enrichment_queue").update({ status: "queued", lease_until: null, updated_at: new Date().toISOString() }).eq("id", row.id).eq("status", "leased");
        throw lockSignal.reason;
      }
      const control = await db.from("chestny_enrichment_runs").select("status").eq("id", runId).single();
      if (control.error) throw new Error(`Cannot read run control: ${control.error.message}`);
      if (["paused", "cancelled"].includes(control.data.status)) pauseAfterCurrent = true;
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
      const saved = await db.from("chestny_enrichment_queue").select("result,attempt_count").eq("id", row.id).single();
      if (saved.error) throw new Error(saved.error.message);
      const previousResult = obj(saved.data.result);
      const checkpoint = obj(previousResult.checkpoint);
      row.attempt_count = saved.data.attempt_count;
      let checkpointData: Record<string, unknown> = checkpoint;
      const saveCheckpoint = async () => {
        const savedCheckpoint = await db.from("chestny_enrichment_queue").update({ result: { ...previousResult, checkpoint: checkpointData } }).eq("id", row.id).eq("status", "leased");
        if (savedCheckpoint.error) throw new Error(savedCheckpoint.error.message);
      };
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
        const detailResponse = await requestJsonWithRetry(agent, `https://api.encar.com/v1/readside/vehicles?vehicleIds=${encodeURIComponent(advertisedId)}&include=SPEC,ADVERTISEMENT,PHOTOS,CATEGORY,MANAGE,CONTACT,VIEW,OPTIONS`, lockSignal);
        if (Array.isArray(detailResponse) && detailResponse.length === 0) throw new Error("detail_empty_response");
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
          const observedAt = new Date().toISOString();
          await complete(db, row, "unavailable", {
            advertisedId, canonicalId, vehicleNo, advertisementStatus,
            failureClass: "source_unavailable", reasonCode: "advertisement_not_active",
            reasonCodes: ["advertisement_not_active"], attempt: row.attempt_count ?? 1,
            observedAt, retryable: false,
          });
          results.push({ sourceListingId: advertisedId, status: "unavailable", reasonCode: "advertisement_not_active", reason: advertisementStatus });
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
          db.from("chestny_catalog_staging").select("source_listing_id,enrichment_status,encar_payload").in("source_listing_id", identityIds),
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
        const verifiedCanonicalSiblings: Array<{ sourceListingId: string; advertisedId: string; canonicalId: string }> = [];
        const identityStagingRows = (stagingResult.data ?? []).filter((item: { source_listing_id: string; enrichment_status: string; encar_payload: Record<string, unknown> | null }) => {
            const payload = obj(item.encar_payload);
            if (payload.runId === runId) return false;
            if (allowMatchingStagingRefresh && item.source_listing_id === advertisedId) {
              const identifiers = obj(payload.identifiers);
              if (String(identifiers.advertisedId ?? "") === advertisedId && String(identifiers.canonicalId ?? "") === canonicalId) return false;
            }
            if (allowVerifiedCanonicalSibling) {
              const identifiers = obj(payload.identifiers);
              const detail = obj(payload.detail);
              if (isVerifiedSameCanonicalRefreshSibling({
                advertisedId,
                canonicalId,
                vehicleNo,
                sourceRunId: String(run.rules.sourceRunId),
                sibling: {
                  sourceListingId: String(item.source_listing_id),
                  advertisedId: text(identifiers.advertisedId),
                  canonicalId: text(identifiers.canonicalId),
                  vehicleNo: text(identifiers.vehicleNo),
                  detailVehicleId: text(detail.vehicleId),
                  detailVehicleNo: text(detail.vehicleNo),
                  runId: text(payload.runId),
                  enrichmentStatus: item.enrichment_status,
                  endpointStatus: obj(payload.endpointStatus),
                  rawReports: obj(payload.rawReports),
                },
              })) {
                const siblingIds = obj(payload.identifiers);
                verifiedCanonicalSiblings.push({
                  sourceListingId: String(item.source_listing_id),
                  advertisedId: String(siblingIds.advertisedId),
                  canonicalId: String(siblingIds.canonicalId),
                });
                return false;
              }
            }
            return true;
          });
        const siblingWarnings = verifiedCanonicalSiblings.map((sibling) => ({
          code: "identity_verified_same_canonical_sibling",
          field: "chestny_catalog_staging.source_listing_id",
          expected: { advertisedId, canonicalId, vehicleNo },
          actual: sibling,
          source: "supabase.chestny_catalog_staging",
          severity: "warning" as const,
        }));
        const existingIssues = validateExistingIdentityLinks(advertisedId, canonicalId, {
          staging: identityStagingRows.map((item: { source_listing_id: string; encar_payload: Record<string, unknown> | null }) => {
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
        // Canonical aliases can be discovered only after detail. Avoid repeated reports.
        const priorCanonical = await db.from("chestny_enrichment_queue").select("source_listing_id")
          .eq("run_id", runId).eq("status", "succeeded").eq("result->>canonicalId", canonicalId)
          .neq("id", row.id).limit(1);
        const plateLinks = await db.from("vehicle_source_identifiers").select("source_identifier,vehicle_id")
          .eq("source_identifier", vehicleNo).limit(2);
        if (priorCanonical.error || plateLinks.error) throw new Error(`identity_lookup_failed:${priorCanonical.error?.message ?? plateLinks.error?.message}`);
        if (priorCanonical.data?.length || plateLinks.data?.length) {
          const issues = [{ code: priorCanonical.data?.length ? "identity_run_canonical_duplicate" : "identity_source_identifier_already_linked",
            field: priorCanonical.data?.length ? "queue.result.canonicalId" : "vehicle_source_identifiers.source_identifier",
            expected: "new unlinked vehicle", actual: { canonicalId, vehicleNo, prior: priorCanonical.data, links: plateLinks.data },
            source: "supabase.queue / vehicle_source_identifiers" }];
          await complete(db, row, "failed", { advertisedId, canonicalId, vehicleNo, failureClass: "identity_integrity",
            retryable: false, integrityIssues: issues, reasonCodes: issues.map(issue => issue.code), supplementalRequests: 0 });
          results.push({ sourceListingId: advertisedId, status: "failed", failureClass: "identity_integrity", reasonCodes: issues.map(issue => issue.code) });
          await sleep(delayMs);
          continue;
        }
        let preliminaryScreening = screenListing(enrichedBundle);
        if (preliminaryScreening.decision === "approved") {
          const earlyReasons = validateGallery(enrichedBundle, images);
          const modifiedAt = Date.parse(String(obj(detail.manage).modifyDateTime ?? ""));
          if (!Number.isFinite(modifiedAt)) earlyReasons.push(evidence("listing_freshness_unconfirmed", "Источник не передал дату актуальности.", {}, "encar.detail.manage"));
          else if (Date.now() - modifiedAt > CATALOG_POLICY.maxListingAgeDays * 86400000) {
            const reason = evidence("stale_listing", "Объявление старше согласованных 180 дней.", { modifiedAt }, "encar.detail.manage");
            preliminaryScreening = { ...preliminaryScreening, decision: "rejected", reasonCodes: [...preliminaryScreening.reasonCodes, reason.code], reasonEvidence: [...preliminaryScreening.reasonEvidence, reason] };
          }
          const normalized = normalizeListing(enrichedBundle);
          if (!normalized.engineCc || !normalized.fuelType || normalized.fuelType === "Не указано") earlyReasons.push(evidence("pricing_characteristics_missing", "Нет обязательных характеристик для расчёта стоимости.", { engineCc: normalized.engineCc, fuelType: normalized.fuelType }, "encar.detail.spec/category"));
          if (earlyReasons.length) preliminaryScreening = isolate(preliminaryScreening, earlyReasons);
        }
        if (preliminaryScreening.decision !== "approved") {
          const skipped = "skipped_pre_screen";
          const spec = obj(detail.spec);
          const payload = {
            runId,
            detail,
            search: currentSearch,
            integrityWarnings: [...integrityIssues.filter((issue) => issue.severity === "warning"), ...siblingWarnings],
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
            screeningDecision: preliminaryScreening.decision,
            reasonEvidence: preliminaryScreening.reasonEvidence,
            reasonCodes: preliminaryScreening.reasonCodes,
          }, payload, text(spec.fuelName), text(spec.colorName), images);
          results.push({ sourceListingId: advertisedId, status: "succeeded", canonicalId, screenedOut: preliminaryScreening.decision, reasonCodes: preliminaryScreening.reasonCodes, supplementalRequests: 0 });
          await sleep(delayMs);
          continue;
        }
        // Revalidate current detail and identity before reusing recent endpoint results.
        if (checkpoint.canonicalId !== canonicalId || checkpoint.vehicleNo !== vehicleNo
          || Date.now() - Date.parse(String(checkpoint.savedAt ?? "")) > 30 * 60_000
          || !Number.isFinite(Date.parse(String(checkpoint.savedAt ?? "")))) {
          checkpointData = { canonicalId, vehicleNo, savedAt: new Date().toISOString(), outcomes: {} };
        }
        checkpointData = { ...checkpointData, detail, images };
        await saveCheckpoint();
        const endpoint = async (name: EncarEndpoint, url: string, id?: string, headers?: Record<string, string>, signal?: AbortSignal) => {
          const outcomes = obj(checkpointData.outcomes);
          const cached = outcomes[name] as EndpointOutcome | undefined;
          if (cached && ["ok", "confirmed_empty", "confirmed_unavailable", "not_found"].includes(cached.state)) return cached;
          const outcome = await requestEndpoint(agent, name, url, id, headers, signal);
          checkpointData = { ...checkpointData, outcomes: { ...outcomes, [name]: outcome } };
          await saveCheckpoint();
          return outcome;
        };
        // Encar is the only source. Keep supplemental calls serialized and
        // spaced just like candidate detail requests; do not burst four APIs.
        if (images.length < 5) throw new Error(`incomplete_gallery:${images.length}`);
        await sleep(delayMs);
        const optionsResult = await endpoint("options", `https://api.encar.com/v1/readside/vehicles/car/${encodeURIComponent(canonicalId)}/options/choice`, canonicalId, undefined, lockSignal);
        assertEndpointNotBlocked(optionsResult);
        if (!["ok", "confirmed_empty", "not_found"].includes(optionsResult.state)) throw new EndpointEnrichmentError(optionsResult);
        await sleep(delayMs);
        const inspectionResult = await endpoint("inspection", `https://api.encar.com/v1/readside/inspection/vehicle/${encodeURIComponent(canonicalId)}`, canonicalId, undefined, lockSignal);
        assertEndpointNotBlocked(inspectionResult);
        await sleep(delayMs);
        const diagnosisResult = await endpoint("diagnosis", `https://api.encar.com/v1/readside/diagnosis/vehicle/${encodeURIComponent(canonicalId)}`, canonicalId, undefined, lockSignal);
        assertEndpointNotBlocked(diagnosisResult);
        if (!["ok", "not_found", "confirmed_unavailable"].includes(diagnosisResult.state)) throw new EndpointEnrichmentError(diagnosisResult);
        await sleep(delayMs);
        const insuranceResult = await endpoint("insurance", `https://api.encar.com/v1/readside/record/vehicle/${encodeURIComponent(canonicalId)}/open?vehicleNo=${encodeURIComponent(vehicleNo)}`, canonicalId, undefined, lockSignal);
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
          const historyAvailability = await requestEndpoint(agent, "history_availability", `https://api.encar.com/v1/vehicle/resume/valid?vehicleNo=${encodeURIComponent(vehicleNo)}`, canonicalId, encarHistoryHeaders(), lockSignal);
          assertEndpointNotBlocked(historyAvailability);
          if (historyAvailability.state === "confirmed_unavailable") {
            historyResult = {
              ...historyAvailability,
              endpoint: "history",
              reasonCode: "history_confirmed_unavailable",
            };
          } else if (historyAvailability.state === "ok") {
            await sleep(delayMs);
            historyResult = await requestEndpoint(agent, "history", `https://api.encar.com/v1/vehicle/resume?vehicleNo=${encodeURIComponent(vehicleNo)}`, canonicalId, encarHistoryHeaders(), lockSignal);
            assertEndpointNotBlocked(historyResult);
          } else {
            historyResult = {
              ...historyAvailability,
              endpoint: "history",
              reasonCode: `history_availability_${historyAvailability.state}`,
            };
          }
        }

        if (!["ok", "confirmed_empty", "not_found"].includes(optionsResult.state)) {
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
        const gate = publicationGate({ bundle: enrichedBundle, queueId: advertisedId, sourceUrl: row.source_url ?? "", snapshot: row.candidate_snapshot as EncarSearchListing, identifiers: { advertisedId, canonicalId, vehicleNo }, images, options: optionsPayload, rawReports: { inspection, diagnosis, insurance, history }, endpointStatus: { options: endpointStatus(optionsResult), inspection: endpointStatus(inspectionResult), diagnosis: endpointStatus(diagnosisResult), insurance: endpointStatus(insuranceResult), history: endpointStatus(historyResult) } });
        const supplementalDecision = gate.screening;
        const payload = {
          runId,
          detail,
          search: currentSearch,
          integrityWarnings: [...integrityIssues.filter((issue) => issue.severity === "warning"), ...siblingWarnings],
          choiceOptions: choiceOptions(optionsPayload),
          equipment: resolveEquipment(detail, optionsPayload),
          inspectionSummary: inspectionData,
          accidentSummary: accidents,
          rawReports: { inspection, diagnosis, insurance, history },
          identifiers: { advertisedId, canonicalId, vehicleNo },
          screening: supplementalDecision,
          publicationGate: gate.proof,
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
          reasonEvidence: supplementalDecision.reasonEvidence,
          galleryImages: images.length,
          accidentCount: accidents.accidentCount,
        }, payload, text(spec.fuelName), text(spec.colorName), images);
        results.push({ sourceListingId: advertisedId, status: "succeeded", canonicalId, reportReady, optionsState: optionsResult.state, historyState: historyResult.state, galleryImages: images.length, accidentCount: accidents.accidentCount });
      } catch (error) {
        if (lockSignal.aborted) {
          await db.from("chestny_enrichment_queue").update({ status: "queued", lease_until: null, updated_at: new Date().toISOString() }).eq("id", row.id).eq("status", "leased");
          throw lockSignal.reason ?? error;
        }
        const message = error instanceof Error ? error.message : String(error);
        const unavailable = (error instanceof EncarRequestError && [404, 410].includes(error.status)) || message === "detail_empty_response";
        const kind = failureClass(message);
        const endpointOutcome = error instanceof EndpointEnrichmentError ? error.outcome : null;
        const temporary = !unavailable && (endpointOutcome?.retryable ?? isRetryableFailure(message));
        const retryExhausted = temporary && Number(row.attempt_count ?? maxAttempts) >= maxAttempts;
        const retryable = temporary && !retryExhausted;
        const finalIsolation = endpointOutcome && ["identity_mismatch", "invalid_payload", "http_error"].includes(endpointOutcome.state);
        const stopState = (endpointOutcome && (isEndpointCircuitBreaker(endpointOutcome)
          || endpointOutcome.state === "auth_error"))
          || ["auth_error", "blocked", "rate_limited"].includes(kind);
        if (stopState) { pauseAfterCurrent = true; pauseMessage = "Источник или прокси ограничил доступ. Требуется проверка подключения; очередь сохранена."; }
        const reportedError = endpointOutcome?.httpStatus ? `HTTP ${endpointOutcome.httpStatus}` : endpointOutcome?.reasonCode ?? message;
        const reasonCode = endpointOutcome?.reasonCode ?? failureReasonCode(message, kind);
        const observedAt = endpointOutcome?.observedAt ?? new Date().toISOString();
        const attempt = endpointOutcome?.attempts ?? row.attempt_count ?? 1;
        await complete(db, row, unavailable ? "unavailable" : "failed", {
          advertisedId,
          ...(finalIsolation ? { screeningDecision: "isolated", reasonEvidence: [evidence(endpointOutcome!.reasonCode, "Ответ источника не подтверждает целостность данных.", { state: endpointOutcome!.state, httpStatus: endpointOutcome!.httpStatus }, `encar.${endpointOutcome!.endpoint}`)] } : {}),
          reason: reasonCode,
          reasonCode,
          reasonCodes: [reasonCode],
          observedAt,
          attempt,
          ...(endpointOutcome ? { endpointStatus: endpointStatus(endpointOutcome) } : {}),
          failureClass: endpointOutcome ? `endpoint_${endpointOutcome.state}` : kind,
          checkpoint: checkpointData,
          retryable, retryExhausted,
          ...(retryable ? { retryAfter: new Date(Date.now() + 5 * 60_000).toISOString(), retryState: "retry_pending" } : {}),
          networkCause: error instanceof Error && error.cause && typeof error.cause === "object"
            ? { code: obj(error.cause).code ?? null, name: obj(error.cause).name ?? null } : null,
        }, undefined, undefined, undefined, [], unavailable ? undefined : (endpointOutcome?.reasonCode ?? message));
        results.push({ sourceListingId: advertisedId, status: unavailable ? "unavailable" : "failed", error: reportedError, reasonCode, failureClass: endpointOutcome ? `endpoint_${endpointOutcome.state}` : kind, retryable, retryExhausted, attempt, observedAt });
      }
      await sleep(delayMs);
    }
    if (pauseAfterCurrent && !preserveRunStatus) {
      const paused = await db.from("chestny_enrichment_runs").update({ status: "paused", pause_reason: { source: "worker_transport", message: pauseMessage || "Выполнение приостановлено владельцем", lastResult: results.at(-1), observedAt: new Date().toISOString() } }).eq("id", runId).in("status", ["approved", "running"]);
      if (paused.error) throw Error(paused.error.message);
    }
    const completed = preserveRunStatus || pauseAfterCurrent ? false : await maybeFinishRun(db);
    console.log(JSON.stringify({ runId, ...(waveId ? { waveId } : {}), transport: direct ? "direct" : "proxy", requestedJson, scheduledWaitMs, delayMs, elapsedMs: Date.now() - startedAt, batchSize, retriesScheduled, pendingRetries: await pendingRetries(db), reserved: rows?.length ?? 0, claimed: results.length, succeeded: results.filter((r) => r.status === "succeeded").length, unavailable: results.filter((r) => r.status === "unavailable").length, failed: results.filter((r) => r.status === "failed").length, completed, results }, null, 2));
  } finally {
    await agent?.close();
    await rm(activePath, { force: true });
  }
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Worker tables are queried dynamically until database types are generated.
  const db: Db = createClient<any>(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  await withEnrichmentWorkerLock({
    db,
    runId,
    inheritedToken: process.env.CHESTNY_ENRICHMENT_LOCK_TOKEN,
    task: (_token, signal) => processBatch(db, signal),
  });
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
