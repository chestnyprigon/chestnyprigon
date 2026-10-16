import { CATALOG_POLICY } from "../encar/catalog-policy";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { withEnrichmentWorkerLock } from "./enrichment-worker-lock";
import { attemptedEnrichmentItems } from "./enrichment-run-state";
import { notifyCatalogOwner } from "./telegram-catalog-notify";
import { readEncarProxyUrlFromKeychain } from "../encar/proxy";

config({ path: ".env.local", quiet: true });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const runId = process.argv.find((argument) => argument.startsWith("--run-id="))?.slice("--run-id=".length);
if (!runId || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(runId)) throw new Error("--run-id must be a run UUID");

const untilComplete = process.argv.includes("--until-complete");
const transportArgument = process.argv.find((argument) => argument.startsWith("--transport="))?.slice("--transport=".length);
const transport = transportArgument ?? "proxy";
if (transport !== "direct" && transport !== "proxy") throw new Error("--transport must be direct or proxy");
const batchSize = 10;
const maxItemsArgument = process.argv.find((argument) => argument.startsWith("--max-items="))?.slice("--max-items=".length);
const maxItems = maxItemsArgument === undefined ? (untilComplete ? 5_000 : 50) : Number(maxItemsArgument);
if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > (untilComplete ? 5_000 : 500)) throw new Error("Invalid --max-items for this worker mode");
const targetedDelayArgument = process.argv.find((argument) => argument.startsWith("--targeted-report-refresh-delay-ms="))?.slice("--targeted-report-refresh-delay-ms=".length);
const requestedTargetedDelayMs = targetedDelayArgument === undefined ? undefined : Number(targetedDelayArgument);
if (requestedTargetedDelayMs !== undefined && (!Number.isInteger(requestedTargetedDelayMs) || requestedTargetedDelayMs < 2_000 || requestedTargetedDelayMs > 30_000)) {
  throw new Error("--targeted-report-refresh-delay-ms must be an integer from 2000 to 30000");
}
const targetedConcurrencyArgument = process.argv.find((argument) => argument.startsWith("--targeted-report-refresh-concurrency="))?.slice("--targeted-report-refresh-concurrency=".length);
const requestedTargetedConcurrency = targetedConcurrencyArgument === undefined ? undefined : Number(targetedConcurrencyArgument);
if (requestedTargetedConcurrency !== undefined && (!Number.isInteger(requestedTargetedConcurrency) || requestedTargetedConcurrency < 1 || requestedTargetedConcurrency > 3)) {
  throw new Error("--targeted-report-refresh-concurrency must be an integer from 1 to 3");
}
const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});
type WorkerResult = {
  claimed: number;
  pendingRetries?: number;
  succeeded: number;
  unavailable: number;
  failed: number;
  requestedJson?: number;
  scheduledWaitMs?: number;
  elapsedMs?: number;
  results: Array<{ status?: string; error?: string; failureClass?: string }>;
};

async function queueCounts(scopeWaveId?: string) {
  const counts: Record<string, number> = {};
  for (const status of ["queued", "leased", "succeeded", "unavailable", "failed", "cancelled"]) {
    let query = client.from("chestny_enrichment_queue")
      .select("id", { count: "exact", head: true })
      .eq("run_id", runId)
      .eq("status", status);
    if (scopeWaveId) query = query.eq("wave_id", scopeWaveId);
    const { count, error } = await query;
    if (error) throw new Error(error.message);
    counts[status] = count ?? 0;
  }
  return counts;
}

async function runBatch(lockToken: string, signal: AbortSignal, limit: number, allowMatchingStagingRefresh: boolean, delayMs: number, encarProxyUrl?: string, waveId?: string): Promise<WorkerResult> {
  const output = await new Promise<string>((resolve, reject) => {
    const activePath = join("/tmp/encar-coordination", `chestny-enrichment-active-${randomUUID()}.json`);
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CHESTNY_ENRICHMENT_DIRECT: String(transport === "direct"),
      CHESTNY_ENRICHMENT_STANDARD_RUN: String(untilComplete),
      CHESTNY_ENRICHMENT_RUN_ID: runId,
      CHESTNY_ENRICHMENT_BATCH_SIZE: String(limit),
      CHESTNY_ENRICHMENT_DELAY_MS: String(delayMs),
      CHESTNY_ENRICHMENT_MAX_ATTEMPTS: "3",
      CHESTNY_ENRICHMENT_SKIP_RETRIES: "false",
      CHESTNY_ENRICHMENT_ALLOW_MATCHING_STAGING_REFRESH: String(allowMatchingStagingRefresh),
      CHESTNY_ENRICHMENT_LOCK_TOKEN: lockToken,
      CHESTNY_ENRICHMENT_ACTIVE_PATH: activePath,
      ...(waveId ? { CHESTNY_ENRICHMENT_WAVE_ID: waveId } : {}),
    };
    delete childEnv.ENCAR_PROXY_URL;
    if (transport === "proxy" && encarProxyUrl) childEnv.ENCAR_PROXY_URL = encarProxyUrl;
    const child = spawn("npm", ["run", "radar:vps-enrichment"], {
      env: childEnv,
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

function mergeWorkerResults(results: WorkerResult[]): WorkerResult {
  return results.reduce<WorkerResult>((combined, item) => ({
    claimed: combined.claimed + item.claimed,
    pendingRetries: Math.max(combined.pendingRetries ?? 0, item.pendingRetries ?? 0),
    succeeded: combined.succeeded + item.succeeded,
    unavailable: combined.unavailable + item.unavailable,
    failed: combined.failed + item.failed,
    requestedJson: (combined.requestedJson ?? 0) + (item.requestedJson ?? 0),
    scheduledWaitMs: (combined.scheduledWaitMs ?? 0) + (item.scheduledWaitMs ?? 0),
    elapsedMs: Math.max(combined.elapsedMs ?? 0, item.elapsedMs ?? 0),
    results: [...combined.results, ...item.results],
  }), { claimed: 0, succeeded: 0, unavailable: 0, failed: 0, results: [] });
}

async function screenCompletedItems(full = false, waveId?: string) {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/radar/screen-vps-staging.ts", ...(full ? ["--full"] : [])], {
      env: { ...process.env, CHESTNY_ENRICHMENT_RUN_ID: runId,
        ...(waveId ? { CHESTNY_ENRICHMENT_WAVE_ID: waveId } : {}),
        CHESTNY_PUBLICATION_OUTPUT_PATH: `output/chestny-vps-publication-ready-${runId}${waveId ? `-wave-${waveId}` : ""}.json` },
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
  const jsonStart = output.indexOf('{\n  "status"');
  if (jsonStart < 0) throw new Error(`Screening did not return a JSON summary: ${output.trim()}`);
  try {
    return JSON.parse(output.slice(jsonStart)) as { decisions?: Record<string, number>; readyForPublication?: number; missingPayload?: number };
  } catch {
    throw new Error(`Screening did not return a summary: ${output.trim()}`);
  }
}

async function publicationDisposition(launchId: string | null) {
  const { data: goal, error } = await client.from("control_center_tasks").select("parameters")
    .eq("module_id", "chestny-prigon.catalog").eq("external_ref", runId).maybeSingle();
  if (error) return "Не удалось проверить разрешение публикации цели; фактический итог будет показан после проверки координатором.";
  let matchedGoal = goal;
  if (!matchedGoal && launchId) {
    const { data, error: goalError } = await client.from("control_center_tasks").select("parameters")
      .eq("module_id", "chestny-prigon.catalog").contains("parameters", { launchId })
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (goalError) return "Не удалось проверить разрешение публикации цели; фактический итог будет показан после проверки координатором.";
    matchedGoal = data;
  }
  const parameters = (matchedGoal?.parameters ?? {}) as Record<string, unknown>;
  if (parameters.publishAuthorized === true && parameters.pilotApproved === true
    && parameters.publicationMode === "whole_run") {
    return "Публикация разрешена пакетно для одобренных карточек; координатор отдельно сообщит фактический итог.";
  }
  return "Публикация цели выключена; карточки не будут опубликованы автоматически.";
}

async function processLoop(lockToken: string, signal: AbortSignal) {
  let batch = 0;
  const { data: run, error: runError } = await client.from("chestny_enrichment_runs")
    .select("status,candidate_count,rules").eq("id", runId).single();
  if (runError) throw new Error(runError.message);
  const savedTransport = run.rules?.transport;
  if (savedTransport && savedTransport !== transport) {
    throw new Error(`Run transport is ${String(savedTransport)}; refusing to continue through ${transport}`);
  }
  if (!(run.status === "approved" || run.status === "running")) throw new Error(`Run status ${run.status} is not eligible for a worker`);
  const refreshRequested = process.argv.includes("--allow-matching-staging-refresh");
  if (refreshRequested && run.rules?.type !== "targeted_report_refresh") {
    throw new Error("--allow-matching-staging-refresh requires a targeted_report_refresh run");
  }
  if (run.rules?.type === "targeted_report_refresh" && !refreshRequested) {
    throw new Error("This targeted_report_refresh run requires --allow-matching-staging-refresh");
  }
  const targetedReportRefresh = run.rules?.type === "targeted_report_refresh";
  const { data: waveRows, error: waveError } = await client.from("chestny_enrichment_waves")
    .select("id,wave_number,candidate_count,status").eq("run_id", runId).order("wave_number");
  if (waveError) throw new Error(`Could not read persisted wave plan: ${waveError.message}`);
  const plannedWaves = waveRows ?? [];
  const activeWave = plannedWaves.find((wave) => ["queued", "enriching", "enriched", "screening", "paused"].includes(wave.status)) ?? null;
  const waveId = activeWave?.id as string | undefined;
  const waveAlreadyEnriched = activeWave?.status === "enriched" || activeWave?.status === "screening";
  if (requestedTargetedDelayMs !== undefined && !targetedReportRefresh) {
    throw new Error("--targeted-report-refresh-delay-ms is only allowed for targeted_report_refresh runs");
  }
  if (requestedTargetedConcurrency !== undefined && !targetedReportRefresh) {
    throw new Error("--targeted-report-refresh-concurrency is only allowed for targeted_report_refresh runs");
  }
  const effectiveDelayMs = targetedReportRefresh ? (requestedTargetedDelayMs ?? 2_000) : CATALOG_POLICY.requestDelayMs;
  const effectiveConcurrency = targetedReportRefresh ? (requestedTargetedConcurrency ?? 2) : 1;
  if (untilComplete && run.rules?.catalogLaunchId && plannedWaves.length === 0) throw new Error("--until-complete is reserved for ordinary runs without a catalog launch");
  let abandonedQuery = client.from("chestny_enrichment_queue").select("id,wave_id").eq("run_id", runId).eq("status", "leased");
  if (waveId) abandonedQuery = abandonedQuery.eq("wave_id", waveId);
  const { data: abandoned, error: abandonedError } = await abandonedQuery;
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
  if (!run.rules?.catalogLaunchId) {
    await notify(untilComplete
      ? `🚗 Обработка сохранённой очереди запущена\n\nВсего: ${run.candidate_count}\nОбработано ранее: ${processedBeforeWave}\nОсталось: ${initialCounts.queued}\nРежим: до конца очереди, последовательно, паузы ${effectiveDelayMs / 1000} секунд.\nПубликация выключена.\nRun: ${runId}`
      : `Началась новая волна run ${runId}. Обработано ранее ${processedBeforeWave}; лимит этой волны ${maxItems}; в очереди ${initialCounts.queued}. Транспорт: ${transport === "direct" ? "домашняя сеть, без прокси" : "Decodo proxy"}.`);
  }
  try {
    const encarProxyUrl = transport === "proxy" ? readEncarProxyUrlFromKeychain() : undefined;
    while (waveId || processedThisWave < maxItems) {
      const { data: currentRun, error: currentRunError } = await client.from("chestny_enrichment_runs")
        .select("status").eq("id", runId).single();
      if (currentRunError) throw new Error(`Cannot refresh run control status: ${currentRunError.message}`);
      if (currentRun.status === "completed") {
        console.log(JSON.stringify({ runId, completedByWorker: true, processed, maxItems }));
        break;
      }
      if (currentRun.status === "paused" || currentRun.status === "cancelled") {
        console.log(JSON.stringify({ runId, stoppedByControl: currentRun.status, processed, maxItems }));
        break;
      }
      if (!(currentRun.status === "approved" || currentRun.status === "running")) {
        throw new Error(`Run changed to unexpected status ${currentRun.status}`);
      }
      const currentLimit = waveId ? batchSize : Math.min(batchSize, maxItems - processedThisWave);
      if (waveId && waveAlreadyEnriched) break;
      const workerResults = targetedReportRefresh
        ? await Promise.all(Array.from({ length: Math.min(effectiveConcurrency, currentLimit) }, () =>
          runBatch(lockToken, signal, 1, refreshRequested, effectiveDelayMs, encarProxyUrl)))
        : [await runBatch(lockToken, signal, currentLimit, refreshRequested, effectiveDelayMs, encarProxyUrl, waveId)];
      const result = mergeWorkerResults(workerResults);
      batch += 1;
      processedThisWave += result.claimed;
      processed += result.claimed;
      const counts = await queueCounts();
      console.log(JSON.stringify({ runId, batch, processedThisWave, processedTotal: processed, maxItems, recoveredLeases: recoveredIds.length, transport, delayMs: effectiveDelayMs, concurrentListings: effectiveConcurrency, ...counts }));
      const progressInterval = untilComplete ? 50 : 10;
      if (processedThisWave > 0 && processedThisWave % progressInterval === 0) {
        const progressMessage = targetedReportRefresh
          ? `Обновление данных Encar: run ${runId}. Обработано ${processed}/${run.candidate_count}; успешно ${counts.succeeded}, недоступно ${counts.unavailable}, ошибок ${counts.failed}; осталось ${counts.queued}. Публикация выключена.`
          : `📈 Прогресс обработки\n\nОбработано: ${processed} из ${run.candidate_count}\nУспешно: ${counts.succeeded}\nНедоступно: ${counts.unavailable}\nОшибок: ${counts.failed}\nОсталось: ${counts.queued}\nТранспорт: ${transport === "direct" ? "домашняя сеть, без прокси" : "Decodo proxy"}\nПубликация выключена.\nRun: ${runId}`;
        await notify(progressMessage);
      }
      if (result.results.some((item) => /HTTP (403|429)|captcha|verification/i.test(item.error ?? "")
        || /^(endpoint_(auth_error|blocked|rate_limited)|auth_error|blocked|rate_limited)$/.test(item.failureClass ?? ""))) {
        throw new Error("Encar access restriction detected; local enrichment paused");
      }
      const scopedCounts = waveId ? await queueCounts(waveId) : counts;
      if (result.pendingRetries && scopedCounts.queued === 0 && scopedCounts.leased === 0) {
        // No Encar requests while waiting; refresh owner control on the next loop.
        await new Promise(resolve => setTimeout(resolve, 30_000));
        continue;
      }
      if (scopedCounts.queued === 0 && scopedCounts.leased === 0) break;
      if (!waveId && processedThisWave >= maxItems) { console.log(JSON.stringify({ runId, stoppedAtLimit: true, processedThisWave, processedTotal: processed, maxItems, ...counts })); break; }
      const controlAfterBatch = await client.from("chestny_enrichment_runs").select("status").eq("id", runId).single();
      if (controlAfterBatch.error) throw new Error(controlAfterBatch.error.message);
      if (["paused", "cancelled"].includes(controlAfterBatch.data.status)) break;
      if (result.claimed === 0) throw new Error("Queue has pending or leased items but the worker claimed none");
    }
    const finalCounts = await queueCounts();
    const finalWaveCounts = waveId ? await queueCounts(waveId) : finalCounts;
    if (waveId && finalWaveCounts.queued + finalWaveCounts.leased === 0 && !waveAlreadyEnriched) {
      const now = new Date().toISOString();
      const { error: checkpointError } = await client.from("chestny_enrichment_waves").update({
        status: "enriched", enrichment_completed_at: now, updated_at: now,
      }).eq("id", waveId).eq("run_id", runId).in("status", ["queued", "enriching"]);
      if (checkpointError) throw new Error(`Could not checkpoint enriched wave ${waveId}: ${checkpointError.message}`);
    }
    if (waveId) {
      const { error: screeningStartError } = await client.from("chestny_enrichment_waves").update({
        status: "screening", updated_at: new Date().toISOString(),
      }).eq("id", waveId).eq("run_id", runId).in("status", ["enriched", "screening"]);
      if (screeningStartError) throw new Error(`Could not start screening checkpoint for wave ${waveId}: ${screeningStartError.message}`);
    }
    if (finalCounts.queued + finalCounts.leased > 0 && (waveId ? finalWaveCounts.queued + finalWaveCounts.leased === 0 : processedThisWave >= maxItems)) {
      const { error } = await client.from("chestny_enrichment_runs").update({
        status: "paused",
        pause_reason: { source: "wave_limit", waveId: waveId ?? null, waveNumber: activeWave?.wave_number ?? null, maxItems, processedThisWave, processedTotal: processed, observedAt: new Date().toISOString() },
      }).eq("id", runId).in("status", ["approved", "running"]);
      if (error) throw new Error(`Could not pause run at wave limit: ${error.message}`);
    }
    const waveComplete = finalWaveCounts.queued + finalWaveCounts.leased === 0;
    const screening = waveId && !waveComplete
      ? null
      : await screenCompletedItems(finalCounts.queued + finalCounts.leased === 0, waveId);
    console.log(JSON.stringify({ runId, screening, ...finalCounts }));
    const publication = await publicationDisposition(run.rules?.catalogLaunchId ? String(run.rules.catalogLaunchId) : null);
    const waveTerminal = finalWaveCounts.succeeded + finalWaveCounts.unavailable + finalWaveCounts.failed + finalWaveCounts.cancelled;
    const waveLabel = waveId ? `Волна ${activeWave?.wave_number}: ${waveTerminal}/${activeWave?.candidate_count}; ` : "";
    const screeningSummary = screening
      ? `Screening волны: допущено ${screening.decisions?.approved ?? 0}, отклонено ${screening.decisions?.rejected ?? 0}, изолировано ${screening.decisions?.isolated ?? 0}; готово к публикации ${screening.readyForPublication ?? 0}.`
      : "Волна поставлена на паузу до завершения обогащения; screening не запускался.";
    await notify(`${waveLabel}run ${runId}: обработано в этой сессии ${processedThisWave}, всего по run ${processed}. Успешно ${finalCounts.succeeded}, недоступно ${finalCounts.unavailable}, ошибок ${finalCounts.failed}; осталось ${finalCounts.queued}. ${screeningSummary} Транспорт: ${transport === "direct" ? "домашняя сеть, без прокси" : "Decodo proxy"}. ${publication}`);
  } catch (error) {
    if (!signal.aborted) {
      if (waveId) {
        const { error: wavePauseError } = await client.from("chestny_enrichment_waves").update({
          status: "paused",
          last_error: { message: error instanceof Error ? error.message : String(error), observedAt: new Date().toISOString() },
          updated_at: new Date().toISOString(),
        }).eq("id", waveId).eq("run_id", runId).in("status", ["queued", "enriching", "enriched", "screening"]);
        if (wavePauseError) throw new Error(`Worker failed and wave checkpoint could not be paused: ${wavePauseError.message}`);
      }
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
