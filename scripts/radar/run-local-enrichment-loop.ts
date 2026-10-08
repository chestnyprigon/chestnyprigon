import { CATALOG_POLICY } from "../encar/catalog-policy";
import { spawn } from "node:child_process";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { withEnrichmentWorkerLock } from "./enrichment-worker-lock";
import { attemptedEnrichmentItems } from "./enrichment-run-state";
import { notifyCatalogOwner } from "./telegram-catalog-notify";

config({ path: ".env.local", quiet: true });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const runId = process.argv.find((argument) => argument.startsWith("--run-id="))?.slice("--run-id=".length);
if (!runId || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(runId)) throw new Error("--run-id must be a run UUID");

const batchSize = 1;
const maxItemsArgument = process.argv.find((argument) => argument.startsWith("--max-items="))?.slice("--max-items=".length);
const maxItems = maxItemsArgument === undefined ? 50 : Number(maxItemsArgument);
if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 500) throw new Error("--max-items must be 1..500");
const delayMs = CATALOG_POLICY.requestDelayMs;
const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

type WorkerResult = {
  claimed: number;
  succeeded: number;
  unavailable: number;
  failed: number;
  results: Array<{ error?: string; failureClass?: string }>;
};

async function queueCounts() {
  const counts: Record<string, number> = {};
  for (const status of ["queued", "leased", "succeeded", "unavailable", "failed", "cancelled"]) {
    const { count, error } = await client.from("chestny_enrichment_queue")
      .select("id", { count: "exact", head: true })
      .eq("run_id", runId)
      .eq("status", status);
    if (error) throw new Error(error.message);
    counts[status] = count ?? 0;
  }
  return counts;
}

async function runBatch(lockToken: string, signal: AbortSignal): Promise<WorkerResult> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("npm", ["run", "radar:vps-enrichment"], {
      env: {
        ...process.env,
        CHESTNY_ENRICHMENT_DIRECT: "true",
        CHESTNY_ENRICHMENT_RUN_ID: runId,
        CHESTNY_ENRICHMENT_BATCH_SIZE: String(batchSize),
        CHESTNY_ENRICHMENT_DELAY_MS: String(delayMs),
        CHESTNY_ENRICHMENT_MAX_ATTEMPTS: "3",
        CHESTNY_ENRICHMENT_LOCK_TOKEN: lockToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`Worker exited ${code}: ${stderr.trim() || stdout.trim()}`));
      else resolve(stdout);
    });
  });
  const jsonStart = output.indexOf('{\n  "runId"');
  if (jsonStart < 0) throw new Error(`Worker did not return a batch summary: ${output.trim()}`);
  return JSON.parse(output.slice(jsonStart)) as WorkerResult;
}

async function screenCompletedItems() {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("npm", ["run", "radar:screen-vps-staging"], {
      env: { ...process.env, CHESTNY_ENRICHMENT_RUN_ID: runId },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`Screening exited ${code}: ${stderr.trim() || stdout.trim()}`));
      else resolve(stdout);
    });
  });
  try {
    return JSON.parse(output) as { decisions?: Record<string, number>; readyForPublication?: number; missingPayload?: number };
  } catch {
    throw new Error(`Screening did not return a summary: ${output.trim()}`);
  }
}

async function processLoop(lockToken: string, signal: AbortSignal) {
  let batch = 0;
  const { data: run, error: runError } = await client.from("chestny_enrichment_runs")
    .select("status").eq("id", runId).single();
  if (runError) throw new Error(runError.message);
  if (!(run.status === "approved" || run.status === "running")) throw new Error(`Run status ${run.status} is not eligible for a worker`);
  const { data: abandoned, error: abandonedError } = await client.from("chestny_enrichment_queue")
    .select("id").eq("run_id", runId).eq("status", "leased");
  if (abandonedError) throw new Error(abandonedError.message);
  const recoveredIds = (abandoned ?? []).map((item: { id: string }) => item.id);
  if (recoveredIds.length) {
    const { error } = await client.from("chestny_enrichment_queue")
      .update({ status: "queued", lease_until: null, updated_at: new Date().toISOString() })
      .in("id", recoveredIds).eq("status", "leased");
    if (error) throw new Error(error.message);
  }
  const initialCounts = await queueCounts();
  let processed = attemptedEnrichmentItems(initialCounts);
  const notify = async (message: string) => {
    try { await notifyCatalogOwner(message); }
    catch (error) { console.error(`Telegram progress notification failed: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const processedBeforeWave = processed;
  let processedThisWave = 0;
  await notify(`Началась новая волна run ${runId}. Обработано ранее ${processedBeforeWave}; лимит этой волны ${maxItems}; в очереди ${initialCounts.queued}.`);
  try {
    while (processedThisWave < maxItems) {
      const { data: currentRun, error: currentRunError } = await client.from("chestny_enrichment_runs")
        .select("status").eq("id", runId).single();
      if (currentRunError) throw new Error(`Cannot refresh run control status: ${currentRunError.message}`);
      if (currentRun.status === "paused" || currentRun.status === "cancelled") {
        console.log(JSON.stringify({ runId, stoppedByControl: currentRun.status, processed, maxItems }));
        break;
      }
      if (!(currentRun.status === "approved" || currentRun.status === "running")) {
        throw new Error(`Run changed to unexpected status ${currentRun.status}`);
      }
      const result = await runBatch(lockToken, signal);
      batch += 1;
      processedThisWave += result.claimed;
      processed += result.claimed;
      const counts = await queueCounts();
      console.log(JSON.stringify({ runId, batch, processedThisWave, processedTotal: processed, maxItems, recoveredLeases: recoveredIds.length, transport: "direct", ...counts }));
      if (processedThisWave > 0 && processedThisWave % 10 === 0) await notify(`Прогресс run ${runId}: эта волна ${processedThisWave}/${maxItems}; всего обработано ${processed}. Успешно ${counts.succeeded}, недоступно ${counts.unavailable}, ошибок ${counts.failed}, осталось в очереди ${counts.queued}.`);
      if (result.results.some((item) => /HTTP (403|429)|captcha|verification/i.test(item.error ?? "")
        || /^(endpoint_(transient_error|auth_error|blocked|rate_limited)|transient_request|auth_error|blocked|rate_limited)$/.test(item.failureClass ?? ""))) {
        throw new Error("Encar access restriction detected; local enrichment paused");
      }
      if (result.claimed > 0 && result.failed >= Math.ceil(result.claimed / 2)) {
        throw new Error("At least half the batch failed; local enrichment paused");
      }
      if (counts.queued === 0 && counts.leased === 0) break;
      if (processedThisWave >= maxItems) { console.log(JSON.stringify({ runId, stoppedAtLimit: true, processedThisWave, processedTotal: processed, maxItems, ...counts })); break; }
      if (result.claimed === 0) throw new Error("Queue has pending or leased items but the worker claimed none");
    }
    const finalCounts = await queueCounts();
    if (finalCounts.queued + finalCounts.leased > 0 && processedThisWave >= maxItems) {
      const { error } = await client.from("chestny_enrichment_runs").update({
        status: "paused",
        pause_reason: { source: "wave_limit", maxItems, processedThisWave, processedTotal: processed, observedAt: new Date().toISOString() },
      }).eq("id", runId).in("status", ["approved", "running"]);
      if (error) throw new Error(`Could not pause run at wave limit: ${error.message}`);
    }
    const screening = await screenCompletedItems();
    console.log(JSON.stringify({ runId, screening, ...finalCounts }));
    await notify(`Волна run ${runId} завершена: обработано в этой волне ${processedThisWave}/${maxItems}, всего ${processed}. Успешно ${finalCounts.succeeded}, недоступно ${finalCounts.unavailable}, ошибок ${finalCounts.failed}; осталось в очереди ${finalCounts.queued}. Screening: допущено ${screening.decisions?.approved ?? 0}, отклонено ${screening.decisions?.rejected ?? 0}, изолировано ${screening.decisions?.isolated ?? 0}; готово к публикации ${screening.readyForPublication ?? 0}. Публикация не выполнялась.`);
  } catch (error) {
    if (!signal.aborted) {
      const { error: pauseError } = await client.from("chestny_enrichment_runs").update({
        status: "paused",
        pause_reason: { source: "local_worker_loop", message: error instanceof Error ? error.message : String(error), observedAt: new Date().toISOString() },
      }).eq("id", runId).in("status", ["approved", "running", "completed"]);
      if (pauseError) throw new Error(`Worker failed and run could not be paused: ${pauseError.message}`);
    }
    await notify(`Worker приостановлен с ошибкой для run ${runId} после ${processed}/${maxItems}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

async function main() {
  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await withEnrichmentWorkerLock({ db: client, runId: runId!, task: (token, signal) => processLoop(token, signal) });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
