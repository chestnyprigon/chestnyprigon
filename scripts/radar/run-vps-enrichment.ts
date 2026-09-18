import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { accidentSummary, inspectionSummary } from "../encar/enrich";

config({ path: ".env", quiet: true });

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
const proxyUrl = required("ENCAR_PROXY_URL");
const coordinationDirectory = process.env.ENCAR_COORDINATION_DIR?.trim() || "/tmp/encar-coordination";
const activePath = `${coordinationDirectory}/chestny-enrichment-active.json`;
const radarPath = `${coordinationDirectory}/radar-priority.json`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value: unknown) => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
};
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
  return Boolean(error && /fetch failed|abort|timeout|timed out|econn|eai_again|socket|proxy|HTTP (408|429|5\d\d)|detail_missing_canonical_identifier/i.test(error));
}

async function requestJson(agent: ProxyAgent, endpoint: string) {
  const response = await undiciFetch(endpoint, {
    headers: {
      Accept: "application/json, text/plain, */*",
      Origin: "https://fem.encar.com",
      Referer: "https://fem.encar.com/",
    },
    dispatcher: agent,
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new EncarRequestError(response.status, endpoint);
  return await response.json() as unknown;
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
  const { data, error } = await db.from("chestny_enrichment_queue").select("status").eq("run_id", runId);
  if (error) throw new Error(error.message);
  const statuses = (data ?? []).map((row) => String(row.status));
  if (statuses.some((status) => status === "queued" || status === "leased")) return false;
  const { error: updateError } = await db.from("chestny_enrichment_runs").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", runId).in("status", ["approved", "running"]);
  if (updateError) throw new Error(updateError.message);
  return true;
}

async function main() {
  const db: Db = createClient<any>(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: run, error: runError } = await db.from("chestny_enrichment_runs").select("status,candidate_count").eq("id", runId).single();
  if (runError) throw new Error(runError.message);
  if (!["approved", "running"].includes(run.status)) throw new Error(`Run status is ${run.status}`);
  if (run.status === "approved") {
    const { error } = await db.from("chestny_enrichment_runs").update({ status: "running", started_at: new Date().toISOString() }).eq("id", runId);
    if (error) throw new Error(error.message);
  }
  await mkdir(coordinationDirectory, { recursive: true });
  await writeFile(activePath, JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() }), { mode: 0o600 });
  const retriesScheduled = await requeueRetryableFailures(db);
  const { data: rows, error } = await db.rpc("claim_chestny_enrichment_queue", { p_run_id: runId, p_limit: batchSize, p_lease_minutes: 45 });
  if (error) throw new Error(error.message);
  const agent = new ProxyAgent(proxyUrl);
  const results: Array<Record<string, unknown>> = [];
  try {
    for (const [index, row] of (rows ?? []).entries() as Iterable<[number, Row]>) {
      if (await radarHasPriority()) {
        const remaining = (rows as Row[]).slice(index).map((item) => item.id);
        if (remaining.length) await db.from("chestny_enrichment_queue").update({ status: "queued", lease_until: null, updated_at: new Date().toISOString() }).in("id", remaining);
        break;
      }
      const advertisedId = row.source_listing_id;
      try {
        // Resolve the canonical ID from detail before calling any other endpoint.
        const detailResponse = await requestJson(agent, `https://api.encar.com/v1/readside/vehicles?vehicleIds=${encodeURIComponent(advertisedId)}&include=SPEC,ADVERTISEMENT,PHOTOS,CATEGORY,MANAGE,CONTACT,VIEW`);
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
        const [optionsResult, inspectionResult, insuranceResult, historyResult] = await Promise.all([
          requestJson(agent, `https://api.encar.com/v1/readside/vehicles/car/${encodeURIComponent(canonicalId)}/options/choice`).catch((e) => e),
          requestJson(agent, `https://api.encar.com/v1/readside/inspection/vehicle/${encodeURIComponent(canonicalId)}`).catch((e) => e),
          requestJson(agent, `https://api.encar.com/v1/readside/record/vehicle/${encodeURIComponent(canonicalId)}/open?vehicleNo=${encodeURIComponent(vehicleNo)}`).catch((e) => e),
          requestJson(agent, `https://api.encar.com/v1/vehicle/resume?vehicleNo=${encodeURIComponent(vehicleNo)}`).catch((e) => e),
        ]);
        const responsePayload = (value: unknown) => value instanceof Error ? null : value;
        const inspection = responsePayload(inspectionResult);
        const insurance = responsePayload(insuranceResult);
        const history = responsePayload(historyResult);
        const optionsPayload = responsePayload(optionsResult);
        const images = photoUrls(detail);
        // Detail and a usable gallery are required for successful staging.
        // A missing report remains a visible status, not a hard reject.
        if (images.length < 5) throw new Error(`incomplete_gallery:${images.length}`);
        const detailBundle = { detail, search: row.candidate_snapshot, fetchedAt: new Date().toISOString() };
        const inspectionData = inspectionSummary(inspection, detailBundle);
        const accidents = accidentSummary(insurance, history);
        const reportReady = Number(obj(inspection).vehicleId) === Number(canonicalId) && typeof obj(insurance).openData === "boolean";
        const spec = obj(detail.spec);
        const payload = {
          runId,
          detail,
          choiceOptions: choiceOptions(optionsPayload),
          inspectionSummary: inspectionData,
          accidentSummary: accidents,
          rawReports: { inspection, insurance, history },
          identifiers: { advertisedId, canonicalId, vehicleNo },
          endpointStatus: {
            options: optionsResult instanceof Error ? optionsResult.message : "ok",
            inspection: inspectionResult instanceof Error ? inspectionResult.message : "ok",
            insurance: insuranceResult instanceof Error ? insuranceResult.message : "ok",
            history: historyResult instanceof Error ? historyResult.message : "ok",
          },
          fetchedAt: new Date().toISOString(),
        };
        await complete(db, row, "succeeded", {
          advertisedId,
          canonicalId,
          vehicleNo,
          inspectionAvailable: Boolean(inspection),
          reportReady,
          galleryImages: images.length,
          accidentCount: accidents.accidentCount,
        }, payload, text(spec.fuelName), text(spec.colorName), images);
        results.push({ sourceListingId: advertisedId, status: "succeeded", canonicalId, reportReady, galleryImages: images.length, accidentCount: accidents.accidentCount });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unavailable = error instanceof EncarRequestError && [404, 410].includes(error.status);
        await complete(db, row, unavailable ? "unavailable" : "failed", { advertisedId, reason: message }, undefined, undefined, undefined, [], unavailable ? undefined : message);
        results.push({ sourceListingId: advertisedId, status: unavailable ? "unavailable" : "failed", error: message });
      }
      await sleep(delayMs);
    }
    const completed = (rows?.length ?? 0) > 0 ? await maybeFinishRun(db) : false;
    console.log(JSON.stringify({ runId, batchSize, retriesScheduled, claimed: rows?.length ?? 0, succeeded: results.filter((r) => r.status === "succeeded").length, unavailable: results.filter((r) => r.status === "unavailable").length, failed: results.filter((r) => r.status === "failed").length, completed, results }, null, 2));
  } finally {
    await agent.close();
    await rm(activePath, { force: true });
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
