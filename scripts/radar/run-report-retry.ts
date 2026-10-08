import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetch, ProxyAgent } from "undici";
import { readFile } from "node:fs/promises";
import { classifyEndpointProbe } from "../encar/endpoint-outcomes";
import { CATALOG_POLICY } from "../encar/catalog-policy";
import { inspectionSummary } from "../encar/enrich";
import { hasPendingEnrichment, isTerminalRun, TERMINAL_RUN_EXIT_CODE } from "./enrichment-run-state";
import { withEnrichmentWorkerLock } from "./enrichment-worker-lock";

config({ path: ".env", quiet: true });
const direct = process.env.CHESTNY_REPORT_RETRY_DIRECT === "true";
if (direct) config({ path: ".env.local", quiet: true });
const runId = process.env.CHESTNY_REPORT_RETRY_RUN_ID;
const batchSize = direct ? 1 : Math.min(50, Math.max(1, Number(process.env.CHESTNY_REPORT_RETRY_BATCH_SIZE ?? 50)));
const delayMs = Math.max(CATALOG_POLICY.requestDelayMs, Number(process.env.CHESTNY_REPORT_RETRY_DELAY_MS ?? CATALOG_POLICY.requestDelayMs));
const dryRun = process.env.CHESTNY_REPORT_RETRY_DRY_RUN === "true";
const proxyUrl = direct ? null : process.env.ENCAR_PROXY_URL?.trim();
const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`Missing ${name}`); return value; };
type Row = { id: string; source_listing_id: string; candidate_snapshot: Record<string, unknown> };
type Probe = { ok: boolean; status?: number; body?: unknown; error?: string; attempts?: number };
type Classification = "ready" | "report_not_found" | "timeout" | "transient_error" | "auth_error" | "http_error" | "captcha" | "blocked" | "rate_limited" | "proxy_error" | "identity_mismatch" | "invalid_payload";
const agent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
const radarPath = `${process.env.ENCAR_COORDINATION_DIR ?? "/tmp/encar-coordination"}/radar-priority.json`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type StagingContext = { canonicalId: string; payload: Record<string, unknown> };

const idOf = (row: Row, staging: Map<string, StagingContext>) => String(
  staging.get(row.source_listing_id)?.canonicalId
    ?? row.candidate_snapshot.canonicalVehicleId
    ?? row.candidate_snapshot.vehicleId
    ?? row.candidate_snapshot.encarId
    ?? row.source_listing_id,
);

async function loadStagingContext(db: SupabaseClient, rows: Row[]) {
  const ids = rows.map((row) => row.source_listing_id).filter(Boolean);
  if (!ids.length) return new Map<string, StagingContext>();
  const { data, error } = await db
    .from("chestny_catalog_staging")
    .select("source_listing_id,encar_payload")
    .in("source_listing_id", ids);
  if (error) throw new Error(error.message);
  return new Map<string, StagingContext>(
    ((data ?? []) as Array<{ source_listing_id: string; encar_payload?: Record<string, unknown> | null }>)
      .map((row) => {
        const payload = row.encar_payload ?? {};
        const detail = payload.detail;
        const vehicleId = detail && typeof detail === "object"
          ? (detail as Record<string, unknown>).vehicleId
          : null;
        return [row.source_listing_id, {
          canonicalId: vehicleId ? String(vehicleId) : row.source_listing_id,
          payload,
        }] as const;
      }),
  );
}

async function syncVehicleReport(
  db: SupabaseClient,
  row: Row,
  canonicalId: string,
  staging: StagingContext | undefined,
  inspection: Probe,
  classification: Classification,
) {
  const { data: vehicle, error: vehicleError } = await db
    .from("vehicles")
    .select("id")
    .eq("source_listing_id", canonicalId)
    .maybeSingle();
  if (vehicleError) throw new Error(vehicleError.message);
  if (!vehicle) return;

  const { data: previous, error: previousError } = await db
    .from("vehicle_reports")
    .select("options,accident_summary,report_status")
    .eq("vehicle_id", vehicle.id)
    .maybeSingle();
  if (previousError) throw new Error(previousError.message);

  // A failed technical retry says nothing about report availability. Preserve
  // the previous report row (especially a previously ready one) until Encar
  // returns either a valid report or an explicit 404/410.
  if (classification !== "ready" && classification !== "report_not_found") return;

  const reportReady = classification === "ready" && inspection.ok;
  const normalizedInspection = reportReady
    ? inspectionSummary(inspection.body, staging?.payload ?? {})
    : null;
  const { error } = await db.from("vehicle_reports").upsert({
    vehicle_id: vehicle.id,
    canonical_vehicle_id: canonicalId,
    options: previous?.options ?? staging?.payload.choiceOptions ?? [],
    inspection_summary: normalizedInspection ?? {},
    accident_summary: previous?.accident_summary ?? {},
    report_status: reportReady ? "ready" : "unavailable",
    fetched_at: new Date().toISOString(),
  }, { onConflict: "vehicle_id" });
  if (error) throw new Error(error.message);
}

function classify(probe: Probe): Classification {
  if (probe.ok) return "ready";
  if (probe.error === "identity_mismatch" || probe.error === "invalid_payload") return probe.error;
  if (/captcha/i.test(probe.error ?? "")) return "captcha";
  if (/proxy|socket|econn|eai_again|fetch failed/i.test(probe.error ?? "")) return "proxy_error";
  if (/timeout|abort|timed out/i.test(probe.error ?? "")) return "timeout";
  if (probe.status === 401) return "auth_error";
  if (probe.status === 403) return "blocked";
  if (probe.status === 429) return "rate_limited";
  if (probe.status === 408 || (probe.status !== undefined && probe.status >= 500)) return "transient_error";
  if (probe.status === 404 || probe.status === 410) return "report_not_found";
  return "http_error";
}
async function probe(url: string, lockSignal?: AbortSignal): Promise<Probe> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let result: Probe;
    try {
      const response = await fetch(url, { headers: { Accept: "application/json", Origin: "https://fem.encar.com", Referer: "https://fem.encar.com/" }, ...(agent ? { dispatcher: agent } : {}), signal: lockSignal ? AbortSignal.any([AbortSignal.timeout(20_000), lockSignal]) : AbortSignal.timeout(20_000) });
      result = response.ok
        ? { ok: true, status: response.status, body: await response.json(), attempts: attempt }
        : { ok: false, status: response.status, attempts: attempt };
    } catch (error) {
      if (lockSignal?.aborted) throw lockSignal.reason ?? error;
      result = { ok: false, error: error instanceof Error ? error.message : String(error), attempts: attempt };
    }
    if (result.ok || attempt === 3) return result;
    const classification = classify(result);
    if (!["timeout", "transient_error", "proxy_error"].includes(classification)) return result;
    await sleep(delayMs * attempt);
  }
  return { ok: false, error: "request_failed_after_retries", attempts: 3 };
}
async function processReportRetry(db: SupabaseClient, lockSignal: AbortSignal) {
  if (!runId) throw new Error("CHESTNY_REPORT_RETRY_RUN_ID is required");
  if (!proxyUrl && !direct) throw new Error("Set CHESTNY_REPORT_RETRY_DIRECT=true for local direct requests, or configure ENCAR_PROXY_URL");
  if (!dryRun && await radarHasPriority()) {
    console.log(JSON.stringify({ runId, deferred: "radar_priority" }));
    await agent?.close();
    return;
  }
  const { data: run, error: runError } = await db.from("chestny_enrichment_runs").select("status").eq("id", runId).single();
  if (runError) throw new Error(runError.message);
  if (!dryRun && isTerminalRun(run.status)) {
    console.log(JSON.stringify({ runId, status: run.status, skipped: "terminal_run" }));
    await agent?.close();
    process.exitCode = TERMINAL_RUN_EXIT_CODE;
    return;
  }
  if (!dryRun && !["approved", "running"].includes(run.status)) throw new Error(`Run status is ${run.status}`);
  if (!dryRun && run.status === "approved") {
    const { error: startError } = await db.from("chestny_enrichment_runs").update({ status: "running", started_at: new Date().toISOString() }).eq("id", runId);
    if (startError) throw new Error(startError.message);
  }
  const { data: rows, error } = dryRun ? await db.from("chestny_enrichment_queue").select("id,source_listing_id,candidate_snapshot").eq("run_id", runId).eq("status", "queued").order("created_at").limit(batchSize) : await db.rpc("claim_chestny_enrichment_queue", { p_run_id: runId, p_limit: batchSize, p_lease_minutes: 30 });
  if (error) throw new Error(error.message);
  const staging = await loadStagingContext(db, (rows ?? []) as Row[]);
  const results: Record<string, unknown>[] = [];
  for (const [index, row] of ((rows ?? []) as Row[]).entries()) {
    if (lockSignal.aborted) {
      if (!dryRun) await db.from("chestny_enrichment_queue").update({ status: "queued", lease_until: null, updated_at: new Date().toISOString() }).in("id", ((rows ?? []) as Row[]).slice(index).map((item) => item.id)).eq("status", "leased");
      throw lockSignal.reason;
    }
    if (!dryRun && await radarHasPriority()) {
      const remaining = ((rows ?? []) as Row[]).slice(index).map((item) => item.id);
      if (remaining.length) await db.from("chestny_enrichment_queue").update({ status: "queued", lease_until: null, updated_at: new Date().toISOString() }).in("id", remaining);
      break;
    }
    const id = idOf(row, staging);
    const inspection = await probe(`https://api.encar.com/v1/readside/inspection/vehicle/${id}`, lockSignal);
    await sleep(delayMs);
    if (inspection.ok) {
      const verified = classifyEndpointProbe({ endpoint: "inspection", httpStatus: inspection.status, payload: inspection.body, canonicalId: id });
      if (verified.state !== "ok") { inspection.ok = false; inspection.error = verified.state; }
    }
    const summary = await probe(`https://api.encar.com/v1/readside/inspection/vehicle/${id}/summary`, lockSignal);
    const inspectionClassification = classify(inspection); const summaryClassification = classify(summary);
    const classification = inspection.ok ? "ready" : inspectionClassification;
    const result = { sourceListingId: row.source_listing_id, encarId: id, classification, inspectionStatus: inspection.status ?? null, summaryStatus: summary.status ?? null, inspectionError: inspection.error ?? null, summaryError: summary.error ?? null, inspectionAvailable: inspection.ok, summaryAvailable: summary.ok };
    if (!dryRun) {
      const status = classification === "ready" || classification === "report_not_found" ? "succeeded" : "failed";
      const done = await db.rpc("complete_chestny_report_retry_item", {
        p_queue_id: row.id,
        p_queue_status: status,
        p_result: result,
        p_inspection: inspection.body ?? null,
        p_summary: summary.body ?? null,
        p_error: status === "failed" ? classification : null,
      });
      if (done.error) throw new Error(done.error.message);
      await syncVehicleReport(db, row, id, staging.get(row.source_listing_id), inspection, classification);
      if (["captcha", "blocked", "rate_limited", "auth_error", "timeout", "transient_error", "proxy_error"].includes(classification)) {
        const remaining = ((rows ?? []) as Row[]).slice(index + 1).map((item) => item.id);
        if (remaining.length) {
          const { error: requeueError } = await db.from("chestny_enrichment_queue").update({ status: "queued", lease_until: null, updated_at: new Date().toISOString() }).in("id", remaining);
          if (requeueError) throw new Error(requeueError.message);
        }
        results.push(result);
        break;
      }
    }
    results.push(result); await sleep(delayMs);
  }
  if (!dryRun) {
    if (!(await hasPendingEnrichment(db, runId))) {
      const { error: completeError } = await db.from("chestny_enrichment_runs").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", runId).in("status", ["approved", "running"]);
      if (completeError) throw new Error(completeError.message);
    }
  }
  console.log(JSON.stringify({ runId, dryRun, transport: direct ? "direct" : "proxy", batchSize, requested: results.length, onlyEndpoints: ["inspection", "summary"], results: results.length <= 10 ? results : undefined }, null, 2)); await agent?.close();
}
async function radarHasPriority() {
  try { const owner = JSON.parse(await readFile(radarPath, "utf8")) as { pid?: number }; if (!Number.isInteger(owner.pid)) return false; try { process.kill(owner.pid!, 0); return true; } catch { return false; } } catch { return false; }
}
async function main() {
  if (!runId) throw new Error("CHESTNY_REPORT_RETRY_RUN_ID is required");
  const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  await withEnrichmentWorkerLock({ db, runId, inheritedToken: process.env.CHESTNY_ENRICHMENT_LOCK_TOKEN, task: (_token, signal) => processReportRetry(db, signal) });
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
