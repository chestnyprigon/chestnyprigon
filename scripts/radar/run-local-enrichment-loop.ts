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
const transport = transportArgument;
if (transport !== "direct" && transport !== "proxy") throw new Error("--transport must be direct or proxy");
const batchSize = 10;
const maxItemsArgument = process.argv.find((argument) => argument.startsWith("--max-items="))?.slice("--max-items=".length);
const maxItems = maxItemsArgument === undefined ? (untilComplete ? Number.POSITIVE_INFINITY : 50) : Number(maxItemsArgument);
const maxItemsLabel = Number.isFinite(maxItems) ? String(maxItems) : "до конца очереди";
if (maxItemsArgument !== undefined && (!Number.isSafeInteger(maxItems) || maxItems < 1 || (!untilComplete && maxItems > 500))) {
  throw new Error("Invalid --max-items for this worker mode");
}
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
function isRetryableInfrastructureFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|Supabase temporarily unavailable|worker lock RPC failed|checkpoint could not be paused/i.test(message);
}
type WorkerResult = {
  claimed: number;
  pendingRetries?: number;
  succeeded: number;
  unavailable: number;
  excluded?: number;
  failed: number;
  requestedJson?: number;
  scheduledWaitMs?: number;
  elapsedMs?: number;
  results: Array<{ status?: string; error?: string; failureClass?: string }>;
};

async function queueCounts(scopeWaveId?: string) {
  const counts: Record<string, number> = {};
  for (const status of ["queued", "leased", "succeeded", "unavailable", "excluded", "failed", "cancelled"]) {
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

async function failedOutcomeCounts(scopeWaveId?: string) {
  const counts = await queueCounts(scopeWaveId);
  return { identityConflicts: counts.excluded ?? 0, technicalErrors: counts.failed };
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
    excluded: (combined.excluded ?? 0) + (item.excluded ?? 0),
    failed: combined.failed + item.failed,
    requestedJson: (combined.requestedJson ?? 0) + (item.requestedJson ?? 0),
    scheduledWaitMs: (combined.scheduledWaitMs ?? 0) + (item.scheduledWaitMs ?? 0),
    elapsedMs: Math.max(combined.elapsedMs ?? 0, item.elapsedMs ?? 0),
    results: [...combined.results, ...item.results],
  }), { claimed: 0, succeeded: 0, unavailable: 0, excluded: 0, failed: 0, results: [] });
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

type WaveRecord = { id: string; wave_number: number; candidate_count: number; status: string; last_error?: Record<string, unknown> | null };
type ScreeningSummary = { decisions?: Record<string, number>; readyForPublication?: number; missingPayload?: number;
  succeededQueueRows?: number; stagingRows?: number; missingStagingCount?: number };
type PublicationReplyMarkup = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

function lastJsonObject(output: string) {
  for (let start = output.lastIndexOf("{"); start >= 0; start = output.lastIndexOf("{", start - 1)) {
    try {
      const parsed: unknown = JSON.parse(output.slice(start).trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* Try an earlier opening brace; child output can contain nested JSON. */ }
  }
  throw new Error(`Command returned no JSON summary: ${output.trim().slice(-2_000)}`);
}

async function runCatalogScript(args: string[], label: string) {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...args], {
      env: { ...process.env, CHESTNY_ENRICHMENT_RUN_ID: runId },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${label} exited ${code}: ${(stderr.trim() || stdout.trim()).slice(-2_000)}`)));
  });
  return lastJsonObject(output);
}

async function publishWaveAfterScreening(wave: WaveRecord) {
  const manifestPath = `output/automatic-publication-wave-${wave.wave_number}-${runId}.json`;
  const prepared = await runCatalogScript(["scripts/radar/prepare-publication-cohort.ts",
    `--run-id=${runId}`, `--wave-number=${wave.wave_number}`, `--output=${manifestPath}`], "Publication cohort preparation");
  const selected = Number(prepared.selectedForPublicationReview ?? 0);
  if (prepared.status !== "prepared_for_review" || prepared.publicationExecuted !== false || !Number.isInteger(selected)) {
    throw new Error("Publication cohort preparation did not return a valid read-only manifest summary");
  }
  if (selected === 0) return { selected: 0, publishedCount: 0, failedCount: 0, skipped: "no_approved_candidates" };
  const result = await runCatalogScript(["scripts/radar/publish-screened-cohort.ts", `--manifest=${manifestPath}`, "--publish"], "Automatic publication");
  if (result.runId !== runId || result.publicationManifestStatus !== "completed"
    || Number(result.selected) !== selected || Number(result.publishedCount) !== selected || Number(result.unfinished) !== 0) {
    throw new Error(`Publication result did not reconcile with the frozen wave roster: ${JSON.stringify(result).slice(0, 1_500)}`);
  }
  return result;
}

async function publicationTotals() {
  const manifests = await client.from("chestny_catalog_publication_manifests").select("id").eq("run_id", runId);
  if (manifests.error) throw new Error(`Could not read publication manifests: ${manifests.error.message}`);
  const ids = (manifests.data ?? []).map((row) => String(row.id));
  if (!ids.length) return { published: 0, failed: 0, pending: 0 };
  const countStatus = async (status: string) => {
    const result = await client.from("chestny_catalog_publication_manifest_items")
      .select("id", { count: "exact", head: true }).in("manifest_id", ids).eq("status", status);
    if (result.error) throw new Error(`Could not count publication items ${status}: ${result.error.message}`);
    return result.count ?? 0;
  };
  const [published, failed, pending, publishing] = await Promise.all([
    countStatus("published"), countStatus("failed"), countStatus("pending"), countStatus("publishing"),
  ]);
  return { published, failed, pending: pending + publishing };
}

function publicationReviewMarkup(readyCount: number) {
  if (readyCount < 1) return undefined;
  return { inline_keyboard: [[{ text: `Проверить публикацию · ${readyCount}`, callback_data: `pub:r:${runId}:${readyCount}` }]] };
}

async function screenWaveInBackground(wave: WaveRecord, full: boolean, autoPublish: boolean,
  publishWave: (wave: WaveRecord) => Promise<Record<string, unknown>>,
  notify: (message: string, markup?: PublicationReplyMarkup) => Promise<void>) {
  try {
    const result = await screenCompletedItems(full, wave.id) as ScreeningSummary;
    if ((result.missingStagingCount ?? 0) > 0 || result.succeededQueueRows !== result.stagingRows) {
      throw new Error(`Сверка staging не пройдена: успешных строк очереди ${result.succeededQueueRows ?? "?"}, строк staging ${result.stagingRows ?? "?"}, отсутствует или неуспешно сохранено ${result.missingStagingCount ?? "?"}. Публикация заблокирована.`);
    }
    const ready = result.readyForPublication ?? 0;
    if (autoPublish && ready > 0) {
      try {
        const publication = await publishWave(wave);
        await notify(`✅ Волна ${wave.wave_number}: скрининг завершён. Допущено ${result.decisions?.approved ?? 0}, отклонено ${result.decisions?.rejected ?? 0}, изолировано ${result.decisions?.isolated ?? 0}. Автоматически опубликовано ${publication.publishedCount ?? 0} из ${publication.selected ?? ready}; ошибок публикации ${publication.failedCount ?? 0}. Run: ${runId}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await notify(`⚠️ Волна ${wave.wave_number} прошла screening (${ready} кандидатов готовы), но автопубликация не завершена: ${message.slice(0, 900)}. Следующие волны продолжаются; повторно Encar не запрашиваю. Run: ${runId}`);
      }
    } else {
      await notify(`✅ Скрининг волны ${wave.wave_number} завершён: допущено ${result.decisions?.approved ?? 0}, отклонено ${result.decisions?.rejected ?? 0}, изолировано ${result.decisions?.isolated ?? 0}; подготовлено к публикации ${ready}.${autoPublish ? " Автопубликация не нужна: допущенных карточек нет." : " Публикация для этого run выключена."} Run: ${runId}`);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    const stage = /сверка staging|staging reconciliation/i.test(message) ? "staging_reconciliation" : "screening";
    const { error: checkpointError } = await client.from("chestny_enrichment_waves").update({
      status: "paused", last_error: { stage, message, observedAt: now }, updated_at: now,
    }).eq("id", wave.id).eq("run_id", runId).eq("status", "screening");
    if (checkpointError) console.error(`Could not pause screening checkpoint for wave ${wave.wave_number}: ${checkpointError.message}`);
    await notify(`⚠️ Волна ${wave.wave_number} не прошла проверку перед публикацией: ${message}. Публикация этой волны заблокирована; остальные волны продолжаются. Run: ${runId}`);
    return false;
  }
}

async function processPersistedWaves(input: {
  waves: WaveRecord[];
  lockToken: string;
  signal: AbortSignal;
  run: { candidate_count: number; rules: Record<string, unknown> | null };
  notify: (message: string, markup?: PublicationReplyMarkup) => Promise<void>;
  setActiveWave: (wave: WaveRecord) => void;
  delayMs: number;
  concurrency: number;
  allowMatchingStagingRefresh: boolean;
}) {
  const { waves, lockToken, signal, run, notify, setActiveWave, delayMs, concurrency, allowMatchingStagingRefresh } = input;
  const screeningJobs: Array<Promise<boolean>> = [];
  let publicationTail: Promise<void> = Promise.resolve();
  const publishWaveSerially = async (wave: WaveRecord) => {
    const publication = publicationTail.then(() => publishWaveAfterScreening(wave));
    publicationTail = publication.then(() => undefined, () => undefined);
    return publication;
  };
  let processedThisSession = 0;
  let processed = attemptedEnrichmentItems(await queueCounts());
  const proxyUrl = transport === "proxy" ? readEncarProxyUrlFromKeychain() : undefined;

  for (const plannedWave of waves) {
    setActiveWave(plannedWave);
    const { data: runControl, error: runControlError } = await client.from("chestny_enrichment_runs")
      .select("status").eq("id", runId).single();
    if (runControlError) throw new Error(`Cannot refresh run control status: ${runControlError.message}`);
    if (["paused", "cancelled"].includes(runControl.status)) break;
    if (runControl.status === "completed") break;
    if (runControl.status !== "running") throw new Error(`Run changed to unexpected status ${runControl.status}`);

    const { data: wave, error: waveError } = await client.from("chestny_enrichment_waves")
      .select("id,wave_number,candidate_count,status,last_error").eq("id", plannedWave.id).eq("run_id", runId).single();
    if (waveError) throw new Error(`Cannot read wave ${plannedWave.wave_number}: ${waveError.message}`);
    const currentWave = wave as WaveRecord;
    if (["ready", "completed"].includes(currentWave.status)) continue;

    if (currentWave.status === "enriched" || currentWave.status === "screening"
      || (currentWave.status === "paused" && currentWave.last_error?.stage === "screening")) {
      const now = new Date().toISOString();
      const { error: updateError } = await client.from("chestny_enrichment_waves").update({ status: "screening", updated_at: now })
        .eq("id", currentWave.id).eq("run_id", runId).in("status", ["enriched", "screening", "paused"]);
      if (updateError) throw new Error(`Could not resume screening for wave ${currentWave.wave_number}: ${updateError.message}`);
      screeningJobs.push(screenWaveInBackground(currentWave, false, run.rules?.publication === "auto_after_screening" && run.rules?.publicationAuthorized === true, publishWaveSerially, notify));
      continue;
    }
    if (!["queued", "enriching", "paused"].includes(currentWave.status)) {
      throw new Error(`Wave ${currentWave.wave_number} has unsupported status ${currentWave.status}`);
    }

    const recoveredQuery = client.from("chestny_enrichment_queue").select("id")
      .eq("run_id", runId).eq("wave_id", currentWave.id).eq("status", "leased");
    const { data: abandoned, error: abandonedError } = await recoveredQuery;
    if (abandonedError) throw new Error(`Could not inspect leases for wave ${currentWave.wave_number}: ${abandonedError.message}`);
    const recoveredIds = (abandoned ?? []).map((row: { id: string }) => row.id);
    if (recoveredIds.length) {
      const { error } = await client.from("chestny_enrichment_queue").update({
        status: "queued", lease_until: null, updated_at: new Date().toISOString(),
      }).in("id", recoveredIds).eq("status", "leased");
      if (error) throw new Error(`Could not recover leases for wave ${currentWave.wave_number}: ${error.message}`);
    }

    let waveCounts = await queueCounts(currentWave.id);
    let checkPendingRetry = true;
    while (waveCounts.queued + waveCounts.leased > 0 || checkPendingRetry) {
      const { data: currentRun, error: currentRunError } = await client.from("chestny_enrichment_runs")
        .select("status").eq("id", runId).single();
      if (currentRunError) throw new Error(`Cannot refresh run control status: ${currentRunError.message}`);
      if (["paused", "cancelled"].includes(currentRun.status)) break;
      if (currentRun.status !== "running") throw new Error(`Run changed to unexpected status ${currentRun.status}`);

      const currentLimit = Math.max(1, Math.min(10, waveCounts.queued));
      checkPendingRetry = false;
      const workerResults = run.rules?.type === "targeted_report_refresh"
        ? await Promise.all(Array.from({ length: Math.min(concurrency, currentLimit) }, () =>
          runBatch(lockToken, signal, 1, allowMatchingStagingRefresh, delayMs, proxyUrl, currentWave.id)))
        : [await runBatch(lockToken, signal, currentLimit, allowMatchingStagingRefresh, delayMs, proxyUrl, currentWave.id)];
      const result = mergeWorkerResults(workerResults);
      processedThisSession += result.claimed;
      processed += result.claimed;
      const globalCounts = await queueCounts();
      waveCounts = await queueCounts(currentWave.id);
      console.log(JSON.stringify({ runId, waveId: currentWave.id, waveNumber: currentWave.wave_number,
        processedThisSession, processedTotal: processed, recoveredLeases: recoveredIds.length, transport, delayMs,
        ...globalCounts, wave: waveCounts }));
      if (result.results.some((item) => /HTTP (401|403|407|429)|captcha|verification/i.test(item.error ?? "")
        || /^(endpoint_(auth_error|blocked|rate_limited)|auth_error|blocked|rate_limited)$/.test(item.failureClass ?? ""))) {
        throw new Error("Encar access restriction detected; local enrichment paused");
      }
      if (result.pendingRetries && waveCounts.queued === 0 && waveCounts.leased === 0) {
        await new Promise(resolve => setTimeout(resolve, 30_000));
        waveCounts = await queueCounts(currentWave.id);
        checkPendingRetry = true;
        continue;
      }
      if (waveCounts.queued + waveCounts.leased === 0) break;
      if (result.claimed === 0) throw new Error(`Wave ${currentWave.wave_number} still has work but the worker claimed none`);
    }

    const { data: afterLoop, error: afterLoopError } = await client.from("chestny_enrichment_runs")
      .select("status").eq("id", runId).single();
    if (afterLoopError) throw new Error(`Cannot read run after wave ${currentWave.wave_number}: ${afterLoopError.message}`);
    if (["paused", "cancelled"].includes(afterLoop.status)) break;
    waveCounts = await queueCounts(currentWave.id);
    if (waveCounts.queued + waveCounts.leased > 0) continue;

    const now = new Date().toISOString();
    if (!["enriched", "screening"].includes(currentWave.status)) {
      const { error } = await client.from("chestny_enrichment_waves").update({
        status: "enriched", last_error: null, enrichment_completed_at: now, updated_at: now,
      }).eq("id", currentWave.id).eq("run_id", runId).in("status", ["queued", "enriching", "paused"]);
      if (error) throw new Error(`Could not checkpoint enriched wave ${currentWave.wave_number}: ${error.message}`);
    }
    const { error: screeningError } = await client.from("chestny_enrichment_waves").update({ status: "screening", last_error: null, updated_at: now })
      .eq("id", currentWave.id).eq("run_id", runId).in("status", ["enriched", "screening"]);
    if (screeningError) throw new Error(`Could not start screening checkpoint for wave ${currentWave.wave_number}: ${screeningError.message}`);
    screeningJobs.push(screenWaveInBackground(currentWave, false, run.rules?.publication === "auto_after_screening" && run.rules?.publicationAuthorized === true, publishWaveSerially, notify));
  }

  await Promise.all(screeningJobs);
  const { data: controlAtEnd, error: controlAtEndError } = await client.from("chestny_enrichment_runs")
    .select("status").eq("id", runId).single();
  if (controlAtEndError) throw new Error(`Could not read final run state: ${controlAtEndError.message}`);
  if (["paused", "cancelled"].includes(controlAtEnd.status)) return;

  const { data: finalWaves, error: finalWavesError } = await client.from("chestny_enrichment_waves")
    .select("status,last_error,wave_number").eq("run_id", runId);
  if (finalWavesError) throw new Error(`Could not verify final wave states: ${finalWavesError.message}`);
  const screeningFailures = (finalWaves ?? []).filter((item) => item.status === "paused"
    && ["screening", "staging_reconciliation"].includes(String((item.last_error as Record<string, unknown> | null)?.stage ?? "")));
  if (screeningFailures.length) {
    const { error } = await client.from("chestny_enrichment_runs").update({
      status: "paused", pause_reason: { source: "screening_attention", failedWaves: screeningFailures.map((item) => item.wave_number), observedAt: new Date().toISOString() },
    }).eq("id", runId).eq("status", "running");
    if (error) throw new Error(`Could not pause run for screening attention: ${error.message}`);
    return;
  }
  const remaining = (finalWaves ?? []).filter((item) => !["ready", "completed"].includes(item.status));
  if (!remaining.length) {
    const { error } = await client.from("chestny_enrichment_runs").update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", runId).eq("status", "running");
    if (error) throw new Error(`Could not complete run after screening: ${error.message}`);
    const finalScreening = await screenCompletedItems(true);
    const ready = finalScreening.readyForPublication ?? 0;
    const autoPublication = run.rules?.publication === "auto_after_screening" && run.rules?.publicationAuthorized === true;
    const totals = autoPublication ? await publicationTotals() : null;
    const markup = autoPublication ? undefined : publicationReviewMarkup(ready);
    await notify(`🏁 Run ${runId} завершён: обработаны все сохранённые волны, полный screening готов. Допущено ${finalScreening.decisions?.approved ?? 0}, отклонено ${finalScreening.decisions?.rejected ?? 0}, изолировано ${finalScreening.decisions?.isolated ?? 0}; подготовлено к публикации ${ready}.${autoPublication
      ? ` Автопубликация по волнам: опубликовано ${totals?.published ?? 0}, ошибок ${totals?.failed ?? 0}, ожидают разбора ${totals?.pending ?? 0}.`
      : ready ? " Публикация не выполнялась. Нажмите кнопку, чтобы проверить состав и перейти к отдельному подтверждению." : " Публикация не выполнялась; допущенных карточек нет."}`, markup);
  }
}

async function publicationDisposition(launchId: string | null, rules?: Record<string, unknown> | null) {
  if (rules?.publication === "auto_after_screening" && rules.publicationAuthorized === true) {
    return "Автопубликация разрешена после screening каждой волны; публикуются только карточки, прошедшие gate.";
  }
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
    && parameters.publicationMode === "current_run_only") {
    return "Публикация отдельно разрешена только для текущего завершённого run; новые волны не запускаются.";
  }
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
  if (savedTransport !== transport) {
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
    .select("id,wave_number,candidate_count,status,last_error").eq("run_id", runId).order("wave_number");
  if (waveError) throw new Error(`Could not read persisted wave plan: ${waveError.message}`);
  const plannedWaves = (waveRows ?? []) as WaveRecord[];
  const activeWave = plannedWaves.find((wave) => ["queued", "enriching", "enriched", "screening", "paused"].includes(wave.status)) ?? null;
  let waveId = activeWave?.id;
  let activeWaveNumber = activeWave?.wave_number;
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
  const notify = async (message: string, markup?: PublicationReplyMarkup) => {
    try { await notifyCatalogOwner(message, markup); }
    catch (error) { console.error(`Telegram progress notification failed: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const processedBeforeWave = processed;
  let processedThisWave = 0;
  if (!run.rules?.catalogLaunchId) {
    await notify(plannedWaves.length
      ? `🚗 Run ${runId} запущен: ${run.candidate_count} кандидатов закреплены в ${plannedWaves.length} сохранённых волнах. Обогащаю волны по очереди; скрининг каждой пойдёт параллельно следующей. Транспорт: ${transport === "direct" ? "домашняя сеть, без прокси" : "Decodo proxy"}. Публикация выключена.`
      : untilComplete
      ? `🚗 Обработка сохранённой очереди запущена\n\nВсего: ${run.candidate_count}\nОбработано ранее: ${processedBeforeWave}\nОсталось: ${initialCounts.queued}\nРежим: до конца очереди, последовательно, паузы ${effectiveDelayMs / 1000} секунд.\nПубликация выключена.\nRun: ${runId}`
      : `Началась новая волна run ${runId}. Обработано ранее ${processedBeforeWave}; лимит этой волны ${maxItems}; в очереди ${initialCounts.queued}. Транспорт: ${transport === "direct" ? "домашняя сеть, без прокси" : "Decodo proxy"}.`);
  }
  try {
    if (plannedWaves.length) {
      await processPersistedWaves({
        waves: plannedWaves, lockToken, signal, run,
        notify,
        setActiveWave: (wave) => { waveId = wave.id; activeWaveNumber = wave.wave_number; },
        delayMs: effectiveDelayMs,
        concurrency: effectiveConcurrency,
        allowMatchingStagingRefresh: refreshRequested,
      });
      return;
    }
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
      const progressInterval = targetedReportRefresh ? 10 : 0;
      if (progressInterval > 0 && processedThisWave > 0 && processedThisWave % progressInterval === 0) {
        const progressMessage = targetedReportRefresh
          ? `Обновление данных Encar: run ${runId}. Обработано ${processed}/${run.candidate_count}; успешно ${counts.succeeded}, недоступно ${counts.unavailable}, исключено как дубли/конфликты ID ${counts.excluded}, технических ошибок ${counts.failed}; осталось ${counts.queued}.`
          : `📈 Прогресс обработки\n\nОбработано: ${processed} из ${run.candidate_count}\nУспешно: ${counts.succeeded}\nНедоступно: ${counts.unavailable}\nДубли/конфликты ID: ${counts.excluded}\nТехнических ошибок: ${counts.failed}\nОсталось: ${counts.queued}\nТранспорт: ${transport === "direct" ? "домашняя сеть, без прокси" : "Decodo proxy"}\nRun: ${runId}`;
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
        pause_reason: { source: "wave_limit", waveId: waveId ?? null, waveNumber: activeWaveNumber ?? null, maxItems, processedThisWave, processedTotal: processed, observedAt: new Date().toISOString() },
      }).eq("id", runId).in("status", ["approved", "running"]);
      if (error) throw new Error(`Could not pause run at wave limit: ${error.message}`);
    }
    const waveComplete = finalWaveCounts.queued + finalWaveCounts.leased === 0;
    const screening = waveId && !waveComplete
      ? null
      : await screenCompletedItems(finalCounts.queued + finalCounts.leased === 0, waveId);
    console.log(JSON.stringify({ runId, screening, ...finalCounts }));
    const publication = await publicationDisposition(run.rules?.catalogLaunchId ? String(run.rules.catalogLaunchId) : null, run.rules);
    const waveTerminal = finalWaveCounts.succeeded + finalWaveCounts.unavailable + finalWaveCounts.excluded + finalWaveCounts.failed + finalWaveCounts.cancelled;
    const failureBreakdown = await failedOutcomeCounts();
    const waveLabel = waveId ? `Волна ${activeWave?.wave_number}: ${waveTerminal}/${activeWave?.candidate_count}; ` : "";
    const screeningSummary = screening
      ? `Screening волны: допущено ${screening.decisions?.approved ?? 0}, отклонено ${screening.decisions?.rejected ?? 0}, изолировано ${screening.decisions?.isolated ?? 0}; готово к публикации ${screening.readyForPublication ?? 0}.`
      : "Волна поставлена на паузу до завершения обогащения; screening не запускался.";
    const fullRunFinished = finalCounts.queued + finalCounts.leased === 0 && !waveId;
    let finalMarkup: PublicationReplyMarkup | undefined;
    if (fullRunFinished && screening) finalMarkup = publicationReviewMarkup(screening.readyForPublication ?? 0);
    const autoPublication = run.rules?.publication === "auto_after_screening" && run.rules?.publicationAuthorized === true;
    await notify(`${waveLabel}run ${runId}: обработано в этой сессии ${processedThisWave}, всего по run ${processed}. Успешно ${finalCounts.succeeded}, недоступно ${finalCounts.unavailable}; технических ошибок ${failureBreakdown.technicalErrors}, исключено из-за дублей/конфликтов ID ${failureBreakdown.identityConflicts}; осталось ${finalCounts.queued}. ${screeningSummary} Транспорт: ${transport === "direct" ? "домашняя сеть, без прокси" : "Decodo proxy"}. ${autoPublication ? "Публикация: автоматически после screening каждой волны." : `${publication} Публикация этой волны не запускалась.`}${finalMarkup && !autoPublication ? " Нажмите кнопку, чтобы проверить состав и перейти к отдельному подтверждению." : ""}`, finalMarkup);
  } catch (error) {
    const retryableInfrastructureFailure = isRetryableInfrastructureFailure(error);
    if (!signal.aborted && !retryableInfrastructureFailure) {
      if (waveId) {
        const { error: wavePauseError } = await client.from("chestny_enrichment_waves").update({
          status: "paused",
          last_error: { stage: "enrichment", message: error instanceof Error ? error.message : String(error), observedAt: new Date().toISOString() },
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
    if (retryableInfrastructureFailure) {
      await notify(`⚠️ Временный сбой связи с Supabase для run ${runId} после ${processed}/${maxItemsLabel}. Сохранённый checkpoint не сбрасываю; Mac mini повторит подключение с паузой, только если run остаётся активным.`);
    } else {
      await notify(`Worker приостановлен с ошибкой для run ${runId} после ${processed}/${maxItemsLabel}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
  const infrastructureFailure = isRetryableInfrastructureFailure(error);
  if (!infrastructureFailure) {
    process.exitCode = 1;
    return;
  }
  const statusClient = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  void (async () => {
    try {
      const { data, error: statusError } = await statusClient.from("chestny_enrichment_runs")
        .select("status").eq("id", runId).maybeSingle();
      // Exit 75 is reserved for the Mac mini supervisor. Never auto-retry a
      // deliberately paused/cancelled run or when its state cannot be verified.
      process.exitCode = !statusError && data?.status === "running" ? 75 : 1;
    } catch {
      process.exitCode = 1;
    }
  })();
});
