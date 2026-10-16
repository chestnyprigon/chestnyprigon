import type { SupabaseClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import type { ControlTask, CoordinatorPlan, ModuleResult, Readiness } from "../contracts";
import { chooseNextWaveSize, processedQueueItems, type WaveCounts } from "../adaptive-wave-size";
import { createChestnyPrigonCatalogModule } from "./chestny-prigon";

type LegacyCommand = { id: string; telegram_user_id: number; telegram_chat_id: number; command: "start" | "pause" | "stop" | "resume"; run_id: string; max_items: number };
type RunRow = { id: string; status: string; pause_reason: Record<string, unknown> | null; rules: Record<string, unknown> | null };

export function createChestnyPrigonRuntime(input: {
  db: SupabaseClient;
  ownerId: string;
  chatId: number;
  executeLegacyCommand(command: LegacyCommand): Promise<string>;
  startInitialWave(task: ControlTask): Promise<{ runId: string | null; queued: number; summary: string }>;
}) {
  const publishRun = async (runId: string): Promise<Record<string, unknown>> => {
    const outputPath = `output/chestny-vps-publication-ready-${runId}.json`;
    const screeningOutput = await new Promise<string>((resolve, reject) => {
      const child = spawn("npm", ["run", "--silent", "radar:screen-vps-staging"], {
        env: { ...process.env, CHESTNY_ENRICHMENT_RUN_ID: runId, CHESTNY_PUBLICATION_OUTPUT_PATH: outputPath },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`Publication screening exited ${code}: ${stderr.trim() || stdout.trim()}`)));
    });
    const jsonStart = screeningOutput.indexOf('{\n  "status"');
    if (jsonStart < 0) throw new Error(`Publication screening returned no summary: ${screeningOutput.trim()}`);
    const screening = JSON.parse(screeningOutput.slice(jsonStart)) as { status?: string; runId?: string; readyForPublication?: number };
    if (screening.status !== "completed" || screening.runId !== runId || !Number.isInteger(screening.readyForPublication)) {
      throw new Error(`Publication screening summary did not match run ${runId}`);
    }
    if (screening.readyForPublication === 0) return { runId, selected: 0, unique: 0, acceptedCount: 0, errorCount: 0, published: false, skipped: "no_approved_candidates" };
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("npm", ["run", "--silent", "radar:publish-vps-staging"], {
        env: { ...process.env, CHESTNY_ENRICHMENT_RUN_ID: runId, CHESTNY_PUBLICATION_OUTPUT_PATH: outputPath },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`Publisher exited ${code}: ${stderr.trim() || stdout.trim()}`)));
    });
    // npm may prefix the publisher output, and the script can emit either
    // pretty-printed JSON or a compact single-line object. Find the last
    // complete JSON object instead of assuming a particular whitespace style.
    for (let start = output.lastIndexOf("{"); start >= 0; start = output.lastIndexOf("{", start - 1)) {
      try {
        const parsed: unknown = JSON.parse(output.slice(start).trim());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        // This opening brace belonged to npm output or an incomplete prefix.
      }
    }
    throw new Error(`Publisher returned no JSON summary: ${output.trim()}`);
  };
  const runFor = async (task: ControlTask): Promise<RunRow> => {
    const runId = task.externalRef;
    if (!runId) throw new Error("Catalog task has no current run reference");
    const { data, error } = await input.db.from("chestny_enrichment_runs").select("id,status,pause_reason,rules").eq("id", runId).single();
    if (error) throw new Error(`Could not read catalog run ${runId}: ${error.message}`);
    return data as RunRow;
  };
  const countsFor = async (runId: string) => {
    const counts: Record<string, number> = {};
    for (const status of ["queued", "leased", "succeeded", "unavailable", "failed", "cancelled"]) {
      const { count, error } = await input.db.from("chestny_enrichment_queue").select("id", { count: "exact", head: true }).eq("run_id", runId).eq("status", status);
      if (error) throw new Error(`Could not read queue count ${status}: ${error.message}`);
      counts[status] = count ?? 0;
    }
    return counts;
  };
  const activeEnrichmentLock = async () => {
    const { data, error } = await input.db.from("chestny_enrichment_worker_lock")
      .select("run_id,expires_at").eq("lock_name", "chestny-catalog-enrichment").maybeSingle();
    if (error) throw new Error(`Could not read Encar worker lock: ${error.message}`);
    return data && Date.parse(data.expires_at) > Date.now() ? data as { run_id: string; expires_at: string } : null;
  };
  const waveCounts = (counts: Record<string, number>): WaveCounts => ({
    queued: counts.queued ?? 0, leased: counts.leased ?? 0, succeeded: counts.succeeded ?? 0,
    unavailable: counts.unavailable ?? 0, failed: counts.failed ?? 0, cancelled: counts.cancelled ?? 0,
  });
  const readiness = async (task: ControlTask): Promise<Readiness> => {
    try {
      if (!task.externalRef && task.progress.intent === "initial_search") {
        const launchId = String(task.parameters.launchId ?? "");
        if (!launchId) return { ready: false, summary: "У цели не задан план каталога", blockers: ["catalog_launch_missing"], details: {} };
        const { data: launch, error } = await input.db.from("chestny_catalog_launches").select("id,status").eq("id", launchId).maybeSingle();
        if (error || !launch) return { ready: false, summary: "План каталога недоступен", blockers: [error?.message ?? "catalog_launch_not_found"], details: {} };
        const ready = ["prepared", "running"].includes(launch.status);
        return { ready, summary: ready ? "План каталога готов к пилотному поиску" : `План каталога в статусе ${launch.status}`,
          blockers: ready ? [] : [`launch_status:${launch.status}`], details: { launchId, status: launch.status } };
      }
      const run = await runFor(task);
      const intent = String(task.progress.intent ?? "start");
      const counts = await countsFor(run.id);
      if (intent === "start" && run.status === "completed" && task.parameters.pilotApproved !== true) {
        return { ready: false, summary: "Следующая волна закрыта до подтверждения результата пилота", blockers: ["pilot_approval_required"], details: { runId: run.id } };
      }
      const lock = intent === "resume" ? await activeEnrichmentLock() : null;
      const canRecoverWaveLimit = run.status === "running" && run.pause_reason?.source === "wave_limit" && !lock;
      const ready = intent === "resume" ? (run.status === "paused" || canRecoverWaveLimit) && !lock
        : intent === "pause" ? ["approved", "running"].includes(run.status)
          : intent === "stop" ? ["approved", "running", "paused"].includes(run.status)
            : run.status === "approved" || (["completed", "cancelled", "paused"].includes(run.status) && counts.queued + counts.leased === 0);
      return { ready, summary: ready ? "Каталожный модуль готов выполнить действие" : `Run сейчас в состоянии ${run.status}`,
        blockers: ready ? [] : [`run_status:${run.status}`, ...(counts.queued + counts.leased ? ["queue_not_empty"] : [])], details: { runId: run.id, status: run.status, counts } };
    } catch (error) {
      return { ready: false, summary: "Не удалось подтвердить готовность каталожного модуля", blockers: [error instanceof Error ? error.message : String(error)], details: {} };
    }
  };

  const execute = async (task: ControlTask, action: LegacyCommand["command"]): Promise<ModuleResult> => {
    const runId = task.externalRef;
    if (!runId && action === "start" && task.progress.intent === "initial_search") {
      const firstWave = await input.startInitialWave(task);
      if (!firstWave.runId) return { state: "ready", summary: firstWave.summary,
        progress: { ...task.progress, stage: "search_exhausted", searchExhausted: true },
        result: { summary: firstWave.summary, searchExhausted: true, queued: firstWave.queued } };
      return { state: "running", summary: firstWave.summary, externalRef: firstWave.runId,
        progress: { ...task.progress, intent: "monitor", stage: "enrichment_screening", currentRunId: firstWave.runId, waveNumber: 1 },
        result: { summary: firstWave.summary, runId: firstWave.runId, queued: firstWave.queued, waveNumber: 1 } };
    }
    if (!runId) throw new Error("Catalog task has no current run reference");
    if (action === "start" && task.progress.intent === "publish") {
      if (task.parameters.pilotApproved !== true || task.parameters.publishAuthorized !== true) throw new Error("Publishing requires explicit pilot and publication authorization");
      const summary = await publishRun(runId);
      const publishedRunIds = [...new Set([...(Array.isArray(task.progress.publishedRunIds) ? task.progress.publishedRunIds.map(String) : []), runId])];
      return { state: "ready", summary: `Публикационный этап завершён для run ${runId}`,
        progress: { ...task.progress, stage: "published", intent: "monitor", publishedRunIds },
        result: summary };
    }
    const waveLimit = Number(task.progress.nextWaveLimit ?? task.parameters.maxItemsPerWave ?? 50);
    if (!Number.isInteger(waveLimit) || waveLimit < 50 || waveLimit > 500) throw new Error(`Invalid adaptive wave size ${waveLimit}; expected 50–500`);
    const summary = await input.executeLegacyCommand({ id: task.id, telegram_user_id: Number(input.ownerId),
      telegram_chat_id: input.chatId, command: action, run_id: runId, max_items: waveLimit });
    const nextWave = action === "start" && task.progress.intent === "next_wave";
    if (nextWave && /новых кандидатов .*нет|новых кандидатов не найдено/i.test(summary)) {
      return { state: "ready", summary, externalRef: runId,
        progress: { ...task.progress, stage: "search_exhausted", searchExhausted: true },
        result: { summary, searchExhausted: true } };
    }
    const discoveredRun = summary.match(/run\s+([0-9a-f]{8}-[0-9a-f-]{27,})/i)?.[1] ?? runId;
    const waveNumber = Number(task.progress.waveNumber ?? 0) + (action === "start" || action === "resume" ? 1 : 0);
    const state = action === "pause" ? "paused" : action === "stop" ? "cancelled" : "running";
    return { state, externalRef: discoveredRun, summary,
      progress: { ...task.progress, intent: "monitor", stage: action === "start" && nextWave ? "next_wave_started" : action === "start" ? "worker_started" : action, currentRunId: discoveredRun, waveNumber },
      result: { summary, currentRunId: discoveredRun, waveNumber } };
  };

  const getStatus = async (task: ControlTask): Promise<ModuleResult> => {
    const run = await runFor(task);
    const counts = await countsFor(run.id);
    const processed = counts.succeeded + counts.unavailable + counts.failed + counts.cancelled;
    return { state: run.status === "approved" ? "ready" : run.status === "running" ? "running" : run.status === "paused" ? "paused" : run.status === "cancelled" ? "cancelled" : "completed",
      summary: `Run ${run.id}: ${run.status}; обработано ${processed}; очередь ${counts.queued}; leased ${counts.leased}`,
      progress: { currentRunId: run.id, runStatus: run.status, processed, queue: counts },
      result: { runId: run.id, runStatus: run.status, counts, pauseReason: run.pause_reason } };
  };

  const planNext = async (task: ControlTask): Promise<CoordinatorPlan> => {
    if (task.progress.searchExhausted === true) return { stage: "search_exhausted", action: null, state: "ready", summary: "В Encar больше не найдено новых кандидатов; задача ждёт изменения квот или источника" };
    if (!task.externalRef) return { stage: "search_candidates", action: "run", state: "ready",
      summary: "Начинаю пилот: последовательный поиск по недостающим квотам, затем очередь, обогащение и screening",
      progress: { intent: "initial_search" } };
    let run: RunRow;
    try { run = await runFor(task); }
    catch (error) { return { stage: "blocked", action: null, state: "paused", summary: error instanceof Error ? error.message : String(error) }; }
    if (run.status === "running") {
      let lock: { run_id: string; expires_at: string } | null;
      try { lock = await activeEnrichmentLock(); }
      catch (error) { return { stage: "worker_lock_error", action: null, state: "paused", summary: error instanceof Error ? error.message : String(error) }; }
      if (lock?.run_id === run.id) return { stage: "enrichment_screening", action: null, state: "running", summary: "Worker обогащает кандидатов; screening выполняется после волны" };
      if (lock) return { stage: "waiting_for_worker_lock", action: null, state: "running", summary: `Жду освобождения общей блокировки Encar другим worker (${lock.run_id})` };
      if (run.pause_reason?.source === "wave_limit") {
        run.status = "paused";
        return { stage: "recover_wave_limit", action: "resume", state: "paused", summary: "Волна уже закончилась, worker lock освобождён; восстанавливаю продолжение очереди", progress: { intent: "resume", currentRunId: run.id } };
      }
      return { stage: "worker_missing", action: null, state: "paused", summary: "Run отмечен как выполняющийся, но worker lock отсутствует; автоматический перезапуск остановлен для безопасной проверки", result: { runId: run.id } };
    }
    if (run.status === "approved") return { stage: "start_worker", action: "run", state: "ready", summary: "Подготовленная волна готова к обогащению", progress: { intent: "start", currentRunId: run.id } };
    if (run.status === "paused") {
      if (run.pause_reason?.source === "wave_limit") {
        let lock: { run_id: string; expires_at: string } | null;
        try { lock = await activeEnrichmentLock(); }
        catch (error) { return { stage: "worker_lock_error", action: null, state: "paused", summary: error instanceof Error ? error.message : String(error) }; }
        if (lock) return { stage: "wave_screening", action: null, state: "running", summary: `Волна завершила обработку; жду окончания screening и освобождения блокировки Encar (${lock.run_id})` };

        const counts = waveCounts(await countsFor(run.id));
        const previous = waveCounts((task.progress.queue ?? counts) as Record<string, number>);
        const currentLimit = Number(task.progress.nextWaveLimit ?? task.parameters.maxItemsPerWave ?? 50);
        const lastWaveLimit = Number(task.progress.lastWaveLimit ?? currentLimit);
        const adaptive = chooseNextWaveSize({ currentLimit, lastWaveLimit, previous, current: counts,
          stableWaves: Number(task.progress.stableWaveCount ?? 0) });
        const processed = processedQueueItems(counts);
        const nextWaveLimit = adaptive.nextLimit;
        return { stage: "continue_wave", action: "resume", state: "paused",
          summary: `Продолжаю очередь после screening; следующая порция — до ${nextWaveLimit} карточек${adaptive.attempted ? ` (предыдущая: ${adaptive.attempted}, ошибок ${adaptive.failures})` : ""}`,
          progress: { intent: "resume", currentRunId: run.id, queue: counts, processed,
            lastWaveLimit: nextWaveLimit, nextWaveLimit, stableWaveCount: adaptive.stableWaves,
            waveSizeDecision: { attempted: adaptive.attempted, failures: adaptive.failures, failureRate: adaptive.failureRate } } };
      }
      return { stage: "paused_for_attention", action: null, state: "paused", summary: "Run приостановлен из-за ошибки или команды владельца", result: { pauseReason: run.pause_reason } };
    }
    if (run.status === "cancelled") return { stage: "cancelled", action: null, state: "cancelled", summary: "Задача остановлена" };
    if (run.status === "completed") {
      const pilotApproved = task.parameters.pilotApproved === true;
      if (!pilotApproved && Number(task.progress.waveNumber ?? 1) >= 1) {
        return { stage: "pilot_review", action: null, state: "ready", summary: "Пилотная волна обработана; жду подтверждения результата пилота перед следующими волнами", result: { runId: run.id, awaitingOwnerApproval: true } };
      }
      if (task.parameters.publishAuthorized !== true || task.parameters.pilotApproved !== true) {
        return { stage: "publication_gate", action: null, state: "ready", summary: "Screening завершён; публикация и продолжение набора ждут отдельного утверждения владельца", result: { runId: run.id, awaitingPublicationAuthorization: true } };
      }
      const publishedRunIds = Array.isArray(task.progress.publishedRunIds) ? task.progress.publishedRunIds.map(String) : [];
      if (task.parameters.publicationMode === "current_run_only") {
        if (publishedRunIds.includes(run.id)) return { stage: "publication_complete", action: null, state: "ready",
          summary: `Публикация run ${run.id} завершена; новые волны автоматически не запускаются`, result: task.result ?? { runId: run.id } };
        return { stage: "publish_wave", action: "run", state: "ready",
          summary: `Публикую только одобренные карточки завершённого run ${run.id}; поиск следующих волн не запускается`,
          progress: { intent: "publish", currentRunId: run.id } };
      }
      const launchId = String(task.parameters.launchId ?? run.rules?.catalogLaunchId ?? "");
      const target = Number(task.parameters.targetPublications ?? 1_000);
      if (!launchId) return { stage: "blocked", action: null, state: "paused", summary: "У задачи не задан catalog launch" };
      const { data: brandRows, error } = await input.db.from("chestny_catalog_brand_search_status").select("published_count").eq("launch_id", launchId);
      if (error) return { stage: "quota_read_error", action: null, state: "paused", summary: `Не удалось проверить цель публикаций: ${error.message}` };
      const published = (brandRows ?? []).reduce((sum, row) => sum + Number(row.published_count ?? 0), 0);
      if (published >= target) return { stage: "goal_completed", action: null, state: "completed", summary: `Цель достигнута: ${published}/${target} новых публикаций`, result: { published, target } };
      if (!publishedRunIds.includes(run.id)) return { stage: "publish_wave", action: "run", state: "ready", summary: `Публикую проверенные карточки волны ${Number(task.progress.waveNumber ?? 1)}`, progress: { intent: "publish", currentRunId: run.id, published, target } };
      return { stage: "search_next_wave", action: "run", state: "ready", summary: `Ищу следующую волну по квотам: опубликовано ${published}/${target}`, progress: { intent: "next_wave", currentRunId: run.id, published, target } };
    }
    return { stage: "awaiting_run", action: null, state: "ready", summary: `Run в состоянии ${run.status}; автоматическое действие не выбрано` };
  };

  return createChestnyPrigonCatalogModule({
    checkReadiness: readiness,
    run: (task) => execute(task, "start"),
    pause: (task) => execute(task, "pause"),
    resume: (task) => execute(task, "resume"),
    stop: (task) => execute(task, "stop"),
    getStatus,
    planNext,
  });
}
