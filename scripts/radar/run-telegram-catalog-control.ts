import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { readTelegramBotToken } from "./telegram-keychain";
import { readEncarProxyUrlFromKeychain } from "../encar/proxy";
import { ControlTaskRepository } from "../control-center/task-repository";
import { ControlTaskService } from "../control-center/task-service";
import { ControlTaskCoordinator } from "../control-center/coordinator";
import { ModuleRegistry } from "../control-center/registry";
import { createChestnyPrigonRuntime } from "../control-center/modules/chestny-prigon-runtime";

config({ path: ".env.local", quiet: true });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const ownerId = required("TELEGRAM_CATALOG_OWNER_ID");
const botToken = readTelegramBotToken();
const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
const stateDir = join(homedir(), "Library", "Application Support", "chestny-prigon");
const activeRunFile = join(stateDir, "active-run");
const activeWaveSizeFile = join(stateDir, "active-wave-size");
const activeTransportFile = join(stateDir, "active-transport");
const telegramProgressFile = join(stateDir, "telegram-progress.json");

type Command = {
  id: string;
  telegram_user_id: number;
  telegram_chat_id: number;
  command: "start" | "pause" | "stop" | "resume";
  run_id: string;
  max_items: number;
};

async function sendTelegram(chatId: number, text: string) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage returned HTTP ${response.status}`);
}

async function publicationPolicy(runId: string) {
  const { data: matchedGoal, error } = await db.from("control_center_tasks").select("parameters")
    .eq("module_id", "chestny-prigon.catalog").eq("external_ref", runId).maybeSingle();
  if (error) throw new Error(`Could not read publication policy for run ${runId}: ${error.message}`);
  let goal = matchedGoal;
  if (!goal) {
    const { data: run, error: runError } = await db.from("chestny_enrichment_runs").select("rules").eq("id", runId).maybeSingle();
    if (runError) throw new Error(`Could not read catalog launch for run ${runId}: ${runError.message}`);
    const launchId = String(run?.rules?.catalogLaunchId ?? "");
    if (launchId) {
      const { data, error: goalError } = await db.from("control_center_tasks").select("parameters")
        .eq("module_id", "chestny-prigon.catalog").contains("parameters", { launchId })
        .order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (goalError) throw new Error(`Could not read catalog launch publication policy: ${goalError.message}`);
      goal = data;
    }
  }
  const parameters = (goal?.parameters ?? {}) as Record<string, unknown>;
  if (parameters.publishAuthorized === true && parameters.pilotApproved === true
    && parameters.publicationMode === "current_run_only") {
    return "Владелец отдельно разрешил публикацию только текущего завершённого run; следующие волны не запускаются автоматически.";
  }
  if (parameters.publishAuthorized === true && parameters.pilotApproved === true
    && parameters.publicationMode === "whole_run") {
    return "Цель разрешает пакетную публикацию только допущенных screening карточек после завершения волны.";
  }
  return "Автопубликация цели выключена; карточки останутся в каталоге кандидатов.";
}

function publicationReport(result: Record<string, unknown>) {
  const selected = Number(result.selected ?? 0);
  const accepted = Number(result.acceptedCount ?? 0);
  const errors = Number(result.errorCount ?? 0);
  const runId = String(result.runId ?? "текущей волны");
  if (result.skipped === "no_approved_candidates" || (selected === 0 && accepted === 0 && errors === 0)) {
    return `Пакетная публикация завершена для run ${runId}: screening не допустил карточек, опубликовано 0.`;
  }
  return `Пакетная публикация run ${runId}: проверено ${selected}, опубликовано ${accepted}, ошибок публикации ${errors}.`;
}

type ProgressRun = {
  id: string;
  status: string;
  candidate_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  pause_reason: unknown;
  rules: Record<string, unknown> | null;
};

type ProgressSnapshot = { runId: string; processed: number; status: string };

async function latestCatalogRun(): Promise<ProgressRun | null> {
  const columns = "id,status,candidate_count,created_at,started_at,completed_at,pause_reason,rules";
  const mainRun = (run: ProgressRun) => run.rules?.type !== "targeted_report_refresh";
  const now = new Date().toISOString();
  const { data: lock, error: lockError } = await db.from("chestny_enrichment_worker_lock")
    .select("run_id").eq("lock_name", "chestny-catalog-enrichment").gt("expires_at", now).maybeSingle();
  if (lockError) throw new Error(`Could not read active catalog worker lock: ${lockError.message}`);
  if (lock?.run_id) {
    const { data, error } = await db.from("chestny_enrichment_runs").select(columns)
      .eq("id", lock.run_id).maybeSingle();
    if (error) throw new Error(`Could not read the run held by the catalog worker: ${error.message}`);
    if (data) return data as ProgressRun;
  }

  const { data: tasks, error: taskError } = await db.from("control_center_tasks")
    .select("state,external_ref").eq("module_id", "chestny-prigon.catalog")
    .in("state", ["queued", "preparing", "running", "ready"])
    .order("updated_at", { ascending: false }).limit(10);
  if (taskError) throw new Error(`Could not read active catalog coordinator tasks: ${taskError.message}`);
  const task = (tasks ?? []).find((item) => item.state === "running" && item.external_ref);
  if (task?.external_ref) {
    const { data, error } = await db.from("chestny_enrichment_runs").select(columns)
      .eq("id", task.external_ref).maybeSingle();
    if (error) throw new Error(`Could not read the run linked to the catalog task: ${error.message}`);
    if (data) return data as ProgressRun;
  }

  const { data: localLive, error: localError } = await db.from("chestny_enrichment_runs")
    .select(columns).eq("project", "chestny-prigon").like("source_file", "local-live-encar-search%")
    .in("status", ["approved", "running", "paused", "completed"])
    .order("started_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false })
    .limit(1).maybeSingle();
  if (localError) throw new Error(`Could not read the latest local Encar run: ${localError.message}`);
  if (localLive) return localLive as ProgressRun;

  const { data, error } = await db.from("chestny_enrichment_runs").select(columns)
    .order("started_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false }).limit(100);
  if (error) throw new Error(`Could not find catalog runs: ${error.message}`);
  const allRuns = (data ?? []) as ProgressRun[];
  const runs = allRuns.filter(mainRun);
  // Never let an old row with a stale "running" status outrank the current
  // worker lock, coordinator task, or most recent local Encar run.
  return runs[0] ?? allRuns[0] ?? null;
}

async function progressCounts(runId: string) {
  const statuses = ["queued", "leased", "succeeded", "unavailable", "failed", "cancelled"];
  const values = await Promise.all(statuses.map(async (status) => {
    const { count, error } = await db.from("chestny_enrichment_queue")
      .select("id", { count: "exact", head: true }).eq("run_id", runId).eq("status", status);
    if (error) throw new Error(`Could not read ${status} count for progress notifications: ${error.message}`);
    return [status, count ?? 0] as const;
  }));
  return Object.fromEntries(values) as Record<string, number>;
}

async function isLocalWorkerActive(runId: string) {
  const marker = (await readFile(activeRunFile, "utf8").catch(() => "")).trim();
  if (marker !== runId) return false;
  try {
    const lock = JSON.parse(await readFile("/tmp/encar-coordination/chestny-catalog-enrichment.lock", "utf8")) as {
      pid?: number; host?: string;
    };
    if (!Number.isInteger(lock.pid) || lock.host !== hostname()) return false;
    process.kill(Number(lock.pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function recoverInterruptedLocalWorker() {
  const runId = (await readFile(activeRunFile, "utf8").catch(() => "")).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(runId)) return;
  const { data: run, error } = await db.from("chestny_enrichment_runs").select("status")
    .eq("id", runId).maybeSingle();
  if (error) throw new Error(`Could not inspect saved local worker run: ${error.message}`);
  if (!run || run.status !== "running") return;
  if (await isLocalWorkerActive(runId)) return;
  const now = new Date().toISOString();
  const { data: lock, error: lockError } = await db.from("chestny_enrichment_worker_lock")
    .select("run_id,expires_at").eq("lock_name", "chestny-catalog-enrichment").gt("expires_at", now).maybeSingle();
  if (lockError) throw new Error(`Could not inspect worker lock during recovery: ${lockError.message}`);
  if (lock) return;

  const recoveryFile = join(stateDir, "worker-recovery.json");
  let previous: { runId?: string; attemptedAt?: string } = {};
  try { previous = JSON.parse(await readFile(recoveryFile, "utf8")) as typeof previous; } catch { /* no prior attempt */ }
  if (previous.runId === runId && previous.attemptedAt && Date.now() - Date.parse(previous.attemptedAt) < 60_000) return;

  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Could not determine macOS GUI user id during recovery");
  const kick = spawnSync("/bin/launchctl", ["kickstart", `gui/${uid}/com.chestnyprigon.catalog-worker`], { encoding: "utf8" });
  if (kick.status !== 0) throw new Error(`Could not recover saved worker ${runId} (launchctl exit ${kick.status ?? "unknown"})`);
  await writeFile(recoveryFile, JSON.stringify({ runId, attemptedAt: now }), { mode: 0o600 });
  await sendTelegram(Number(ownerId), `🔄 Восстанавливаю незавершённый run ${runId} из сохранённой очереди после перезапуска процесса. Проверка не делала запросов к Encar; worker продолжит с сохранённого этапа.`);
}

async function monitorCatalogProgress() {
  let snapshot: ProgressSnapshot | null = null;
  try { snapshot = JSON.parse(await readFile(telegramProgressFile, "utf8")) as ProgressSnapshot; }
  catch { /* No prior notification snapshot; announce the active run once. */ }

  const active = await latestCatalogRun();
  let run = active;
  if (!run && snapshot?.runId) {
    const { data, error } = await db.from("chestny_enrichment_runs")
      .select("id,status,candidate_count,created_at,started_at,completed_at,pause_reason,rules")
      .eq("id", snapshot.runId).maybeSingle();
    if (error) throw new Error(`Could not read monitored catalog run: ${error.message}`);
    run = data as ProgressRun | null;
  }
  if (!run) return;

  const counts = await progressCounts(run.id);
  const processed = counts.succeeded + counts.unavailable + counts.failed + counts.cancelled;
  const previous = snapshot?.runId === run.id ? snapshot : null;
  const locallyMonitored = await isLocalWorkerActive(run.id);
  const terminal = ["completed", "cancelled", "failed"].includes(run.status);
  let message: string | null = null;

  if (previous && terminal && previous.status !== run.status && !locallyMonitored) {
    message = `🏁 Run каталога ${run.id} ${run.status === "completed" ? "завершён" : run.status === "cancelled" ? "отменён" : "остановлен с ошибкой"}.\nОбработано ${processed}/${run.candidate_count}; успешно ${counts.succeeded}, недоступно ${counts.unavailable}, ошибок ${counts.failed}; осталось ${counts.queued}.`;
  } else if (previous && run.status === "paused" && previous.status !== "paused") {
    message = `⏸ Run каталога ${run.id} приостановлен.\nОбработано ${processed}/${run.candidate_count}; очередь ${counts.queued}; в работе ${counts.leased}.${run.pause_reason ? `\nПричина: ${JSON.stringify(run.pause_reason).slice(0, 350)}` : ""}`;
  } else if (previous && processed - previous.processed >= 50 && !locallyMonitored) {
    message = `📈 Прогресс каталога\n\nОбработано ${processed} из ${run.candidate_count}\nУспешно: ${counts.succeeded}\nНедоступно: ${counts.unavailable}\nОшибок: ${counts.failed}\nВ очереди: ${counts.queued}; в работе: ${counts.leased}\nRun: ${run.id}`;
  } else if (!previous && !terminal && !locallyMonitored) {
    message = `🚗 Контроль каталога подключён к текущему run ${run.id}.\nСостояние: ${run.status}; обработано ${processed}/${run.candidate_count}; очередь ${counts.queued}, в работе ${counts.leased}.`;
  }

  if (message) await sendTelegram(Number(ownerId), message);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lastReportedProcessed = message || locallyMonitored ? processed : previous?.processed ?? processed;
  await writeFile(telegramProgressFile, JSON.stringify({ runId: run.id, processed: lastReportedProcessed,
    status: run.status } satisfies ProgressSnapshot), { mode: 0o600 });
}

async function setRunStatus(runId: string, status: string, allowed: string[]) {
  const { data, error } = await db.from("chestny_enrichment_runs").select("status").eq("id", runId).single();
  if (error) throw new Error(`Cannot read run: ${error.message}`);
  if (!allowed.includes(data.status)) throw new Error(`Run ${runId} has status ${data.status}; command requires ${allowed.join(" or ")}`);
  const update: Record<string, unknown> = { status };
  if (status === "running") update.started_at = new Date().toISOString();
  if (status === "cancelled" || status === "completed") update.completed_at = new Date().toISOString();
  const { data: changed, error: updateError } = await db.from("chestny_enrichment_runs")
    .update(update).eq("id", runId).eq("status", data.status).select("id").maybeSingle();
  if (updateError) throw new Error(`Cannot change run status: ${updateError.message}`);
  if (!changed) throw new Error(`Run status changed concurrently; expected ${data.status}`);
}

async function startWorker(command: Command) {
  if (!Number.isInteger(command.max_items) || command.max_items < 1 || command.max_items > 500) {
    throw new Error(`Invalid worker wave size ${command.max_items}; expected 1–500`);
  }
  const existing = await readFile(activeRunFile, "utf8").catch(() => "");
  const existingRunId = existing.trim();
  if (existingRunId && existingRunId !== command.run_id) {
    const { data: markedRun, error } = await db.from("chestny_enrichment_runs").select("status").eq("id", existingRunId).maybeSingle();
    if (error) throw new Error(`Could not inspect previously marked run ${existingRunId}: ${error.message}`);
    if (markedRun && ["approved", "running"].includes(markedRun.status)) {
      throw new Error(`Another run ${existingRunId} is still ${markedRun.status}; refusing to start a second worker`);
    }
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const modeRun = await db.from("chestny_enrichment_runs").select("rules").eq("id", command.run_id).single();
  if (modeRun.error) throw new Error(`Could not inspect worker mode: ${modeRun.error.message}`);
  const { data: persistedWaves, error: waveError } = await db.from("chestny_enrichment_waves")
    .select("id,wave_number,candidate_count,status").eq("run_id", command.run_id).order("wave_number");
  if (waveError) throw new Error(`Could not inspect persisted wave plan: ${waveError.message}`);
  const activeWave = (persistedWaves ?? []).find((wave) => ["queued", "enriching", "enriched", "screening", "paused"].includes(wave.status));
  const workerLimit = activeWave ? Number(activeWave.candidate_count) : command.max_items;
  if (!Number.isInteger(workerLimit) || workerLimit < 1 || workerLimit > 500) {
    throw new Error(`Persisted wave size ${workerLimit} is outside the supported range 1–500`);
  }
  const configuredTransport = modeRun.data.rules?.transport;
  if (configuredTransport !== "direct" && configuredTransport !== "proxy") {
    throw new Error(`Run has unsupported Encar transport ${String(configuredTransport)}`);
  }
  const transport = configuredTransport;
  if (transport === "proxy") readEncarProxyUrlFromKeychain();
  const now = new Date().toISOString();
  const { data: workerLock, error: lockError } = await db.from("chestny_enrichment_worker_lock")
    .select("run_id,expires_at").eq("lock_name", "chestny-catalog-enrichment").gt("expires_at", now).maybeSingle();
  if (lockError) throw new Error(`Could not verify worker lock during preflight: ${lockError.message}`);
  if (workerLock) throw new Error(`Preflight stopped: Encar worker lock is held by run ${workerLock.run_id}`);
  const queueCounts = await Promise.all(["queued", "leased"].map(async (status) => {
    const { count, error } = await db.from("chestny_enrichment_queue").select("id", { count: "exact", head: true })
      .eq("run_id", command.run_id).eq("status", status);
    if (error) throw new Error(`Could not count ${status} candidates during preflight: ${error.message}`);
    return [status, count ?? 0] as const;
  }));
  const resumableWave = (persistedWaves ?? []).some((wave) =>
    ["queued", "enriching", "enriched", "screening", "paused"].includes(wave.status));
  if (!resumableWave && queueCounts.every(([, count]) => count === 0)) {
    throw new Error("Preflight stopped: run has no queued work or unfinished screening wave");
  }
  const preflight = { status: "passed", runId: command.run_id, transport: transport === "direct" ? "direct_home_network" : "decodo_proxy",
    proxyCredential: transport === "proxy" ? "available in login Keychain" : "not read",
    proxyDispatcherUsed: transport === "proxy", queued: queueCounts.find(([name]) => name === "queued")?.[1] ?? 0,
    leased: queueCounts.find(([name]) => name === "leased")?.[1] ?? 0,
    savedWaves: persistedWaves?.length ?? 0, encarRequestsMade: 0, queueClaimsMade: 0, publicationAttempted: false };
  console.log(JSON.stringify({ workerPreflight: preflight }));
  await writeFile(activeTransportFile, transport, { mode: 0o600 });
  if (modeRun.data.rules?.type === "saved_queue_remainder") {
    await writeFile(join(stateDir, "active-mode"), "saved_queue_until_complete", { mode: 0o600 });
  } else if (modeRun.data.rules?.type !== "targeted_report_refresh") {
    await unlink(join(stateDir, "active-mode")).catch(() => undefined);
  }
  if (existingRunId && existingRunId !== command.run_id) await writeFile(activeRunFile, command.run_id, { mode: 0o600 });
  else if (!existingRunId) await writeFile(activeRunFile, command.run_id, { mode: 0o600, flag: "wx" });
  await writeFile(activeWaveSizeFile, String(workerLimit), { mode: 0o600 });
  try {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Could not determine macOS GUI user id");
    const kick = spawnSync("/bin/launchctl", ["kickstart", `gui/${uid}/com.chestnyprigon.catalog-worker`], { encoding: "utf8" });
    if (kick.status !== 0) throw new Error(`Could not start worker LaunchAgent (exit ${kick.status ?? "unknown"})`);
    return preflight;
  } catch (error) {
    if (!existing.trim()) await unlink(activeRunFile).catch(() => undefined);
    await unlink(activeWaveSizeFile).catch(() => undefined);
    throw error;
  }
}

async function searchNextWave(launchId?: string) {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("npm", ["run", "--silent", "catalog:search-local", "--", "--apply", "--pilot-candidates=50", "--transport=direct"], {
      cwd: process.cwd(),
      env: { ...process.env, CHESTNY_ENCAR_TRANSPORT: "direct", ...(launchId ? { CHESTNY_CATALOG_LAUNCH_ID: launchId } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`Quota search exited ${code}: ${stderr.trim() || stdout.trim()}`));
      else resolve(stdout);
    });
  });
  try {
    return JSON.parse(output.trim()) as { mode: string; runId?: string; queued?: number; pages?: Array<{ manufacturer: string; newCandidates: number }>; noSearchableBrands?: boolean };
  } catch {
    throw new Error(`Quota search did not return a summary: ${output.trim()}`);
  }
}

async function startPreparedRun(command: Command) {
  const { data: current, error } = await db.from("chestny_enrichment_runs").select("status").eq("id", command.run_id).single();
  if (error) throw new Error(`Cannot read run before worker start: ${error.message}`);
  if (current.status === "approved") {
    const { data: existingWaves, error: wavesError } = await db.from("chestny_enrichment_waves")
      .select("id").eq("run_id", command.run_id).limit(1);
    if (wavesError) throw new Error(`Cannot inspect saved wave plan: ${wavesError.message}`);
    if (!existingWaves?.length) {
      const { count: queuedCount, error: queuedError } = await db.from("chestny_enrichment_queue")
        .select("id", { count: "exact", head: true }).eq("run_id", command.run_id).eq("status", "queued");
      if (queuedError) throw new Error(`Cannot inspect queue before wave planning: ${queuedError.message}`);
      const { count: nonQueuedCount, error: nonQueuedError } = await db.from("chestny_enrichment_queue")
        .select("id", { count: "exact", head: true }).eq("run_id", command.run_id).neq("status", "queued");
      if (nonQueuedError) throw new Error(`Cannot inspect queue statuses before wave planning: ${nonQueuedError.message}`);
      if ((queuedCount ?? 0) > 0 && (nonQueuedCount ?? 0) === 0) {
        const { data: wavePlan, error: planError } = await db.rpc("plan_chestny_enrichment_waves", {
          p_run_id: command.run_id,
          p_safe_wave_capacity: command.max_items,
          p_plan: { source: "macmini_worker_start", policyVersion: "balanced-wave-v1", configuredSafeCapacity: command.max_items },
        });
        if (planError) throw new Error(`Cannot persist wave plan; worker was not started: ${planError.message}`);
        console.log(JSON.stringify({ wavePlan }));
      }
    }
  }
  const transitioned = current.status === "approved";
  if (transitioned) await setRunStatus(command.run_id, "running", ["approved"]);
  else if (current.status !== "running") throw new Error(`Run ${command.run_id} has status ${current.status}; worker can start only from approved or running`);
  try {
    return await startWorker(command);
  } catch (error) {
    const marker = await readFile(activeRunFile, "utf8").catch(() => "");
    if (marker.trim() === command.run_id) await unlink(activeRunFile).catch(() => undefined);
    if (transitioned) await setRunStatus(command.run_id, "approved", ["running"]).catch(() => undefined);
    throw error;
  }
}

async function startInitialWave(task: { id: string; parameters: Record<string, unknown> }) {
  const launchId = String(task.parameters.launchId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(launchId)) throw new Error("Pilot task has an invalid catalog launch id");
  await sendTelegram(Number(ownerId), "Пилотная цель принята. Начинаю последовательный поиск по квотам; прежний paused run и его очередь не меняю. После поиска запущу обогащение и screening. Публикация выключена.").catch(() => undefined);
  const search = await searchNextWave(launchId);
  if (!search.runId) {
    const summary = "Поиск завершён: новых кандидатов для пилотной волны не найдено. Публикация не выполнялась.";
    await sendTelegram(Number(ownerId), summary).catch(() => undefined);
    return { runId: null, queued: 0, summary };
  }
  const { count, error } = await db.from("chestny_enrichment_queue")
    .select("id", { count: "exact", head: true }).eq("run_id", search.runId).in("status", ["queued", "leased"]);
  if (error) throw new Error(`Could not count pilot candidates: ${error.message}`);
  const queued = count ?? 0;
  if (!queued) {
    const { data: discoveredRun, error: runError } = await db.from("chestny_enrichment_runs").select("status").eq("id", search.runId).single();
    if (runError) throw new Error(`Could not inspect the discovered pilot run: ${runError.message}`);
    if (discoveredRun.status === "approved") {
      await setRunStatus(search.runId, "completed", ["approved"]);
      const summary = "Поиск завершён: новых кандидатов для пилотной волны не найдено. Offset и статусы марок сохранены; публикация не выполнялась.";
      await sendTelegram(Number(ownerId), summary).catch(() => undefined);
      return { runId: null, queued: 0, summary };
    }
    if (discoveredRun.status !== "running") throw new Error(`Discovered pilot run has unexpected status ${discoveredRun.status}`);
  }
  const preflight = await startPreparedRun({ id: task.id, telegram_user_id: Number(ownerId), telegram_chat_id: Number(ownerId), command: "start", run_id: search.runId, max_items: 50 });
  await sendTelegram(Number(ownerId), `Пилот запущен: поиск нашёл ${queued} кандидатов. Предстартовая проверка пройдена: ${preflight.transport === "direct_home_network" ? "домашняя сеть, без прокси" : "Decodo proxy"}; запросов Encar при проверке не было. Начались обогащение и screening. Публикация выключена.`).catch(() => undefined);
  return { runId: search.runId, queued,
    summary: `Пилотный поиск завершён: ${queued} кандидатов в run ${search.runId}. Worker запущен; далее обогащение и screening. Публикация выключена.` };
}

async function processCommand(command: Command) {
  if (String(command.telegram_user_id) !== ownerId) throw new Error("Command owner does not match the configured Telegram owner");
  if (command.max_items < 1 || command.max_items > 500) throw new Error("Command exceeds the approved 500-item wave maximum");

  switch (command.command) {
    case "start":
      {
        const { data: current, error } = await db.from("chestny_enrichment_runs").select("status").eq("id", command.run_id).single();
        if (error) throw new Error(`Cannot read run before start: ${error.message}`);
        if (["completed", "cancelled", "paused"].includes(current.status)) {
          const { count: queued, error: queueError } = await db.from("chestny_enrichment_queue")
            .select("id", { count: "exact", head: true }).eq("run_id", command.run_id).in("status", ["queued", "leased"]);
          if (queueError) throw new Error(`Cannot verify previous queue: ${queueError.message}`);
          if ((queued ?? 0) > 0) throw new Error("Previous wave still has queued or leased candidates; resume it or stop it before starting a new search");

          const policy = await publicationPolicy(command.run_id);
          await sendTelegram(command.telegram_chat_id, `Ищу следующую волну по незакрытым квотам. Поиск идёт последовательно; offset сохраняется после каждой страницы. Затем начнутся обогащение и screening. ${policy}`).catch(() => undefined);
          const search = await searchNextWave();
          if (!search.runId) {
            return "Поиск завершён: новых кандидатов для следующей волны пока нет. Состояние и offset по маркам сохранены; публикация не выполнялась.";
          }
          const { count: queuedCount, error: newQueueError } = await db.from("chestny_enrichment_queue")
            .select("id", { count: "exact", head: true }).eq("run_id", search.runId).eq("status", "queued");
          if (newQueueError) throw new Error(`Could not count candidates from the new search: ${newQueueError.message}`);
          if (!queuedCount) {
            await setRunStatus(search.runId, "completed", ["approved"]);
            return `Поиск завершён, но новых кандидатов не найдено. Позиции марок сохранены; следующий поиск начнётся с них. Публикации нет.`;
          }
          const preflight = await startPreparedRun({ ...command, run_id: search.runId });
          const newRunPolicy = await publicationPolicy(search.runId);
          return `Поиск завершён: в run ${search.runId} добавлено ${queuedCount} новых кандидатов. Предстартовая проверка пройдена через ${preflight.transport === "direct_home_network" ? "домашнюю сеть без прокси" : "Decodo proxy"}; запросов Encar при проверке не было. Worker запущен; после обогащения выполнится screening. ${newRunPolicy}`;
        }
        if (current.status !== "approved") throw new Error(`Run ${command.run_id} has status ${current.status}; it is not ready to start`);
        const preflight = await startPreparedRun(command);
        return `Начата обработка подготовленной волны run ${command.run_id}, лимит ${command.max_items}. Предстартовая проверка пройдена: ${preflight.transport === "direct_home_network" ? "домашняя сеть, без прокси" : "Decodo proxy"}; запросов Encar при проверке не было. Новые объявления не ищутся. ${await publicationPolicy(command.run_id)}`;
      }
    case "resume": {
      const { data: current, error } = await db.from("chestny_enrichment_runs")
        .select("status,pause_reason").eq("id", command.run_id).single();
      if (error) throw new Error(`Cannot read run before resume: ${error.message}`);
      const { data: workerLock, error: lockError } = await db.from("chestny_enrichment_worker_lock")
        .select("run_id,expires_at").eq("lock_name", "chestny-catalog-enrichment").maybeSingle();
      if (lockError) throw new Error(`Cannot check Encar worker lock: ${lockError.message}`);
      if (workerLock && Date.parse(workerLock.expires_at) > Date.now()) {
        throw new Error(`Another Encar worker still holds the global lock for run ${workerLock.run_id}; resume was not started`);
      }
      if (current.status === "running" && current.pause_reason?.source === "wave_limit") {
        await setRunStatus(command.run_id, "paused", ["running"]);
      }
      await setRunStatus(command.run_id, "running", ["paused"]);
      let preflight: Awaited<ReturnType<typeof startWorker>>;
      try {
        preflight = await startWorker(command);
      } catch (error) {
        const marker = await readFile(activeRunFile, "utf8").catch(() => "");
        if (marker.trim() === command.run_id) await unlink(activeRunFile).catch(() => undefined);
        await setRunStatus(command.run_id, "paused", ["running"]).catch(() => undefined);
        throw error;
      }
      return `Волна run ${command.run_id} возобновлена; лимит — ${command.max_items}. Предстартовая проверка пройдена: ${preflight.transport === "direct_home_network" ? "домашняя сеть, без прокси" : "Decodo proxy"}; запросов Encar при проверке не было. После обработки автоматически выполняется screening. ${await publicationPolicy(command.run_id)}`;
    }
    case "pause":
      await setRunStatus(command.run_id, "paused", ["approved", "running"]);
      return `Run ${command.run_id} приостановлен. Текущая карточка завершится перед остановкой.`;
    case "stop": {
      await setRunStatus(command.run_id, "cancelled", ["approved", "running", "paused"]);
      const { error } = await db.from("chestny_enrichment_queue").update({ status: "cancelled", lease_until: null, updated_at: new Date().toISOString() })
        .eq("run_id", command.run_id).eq("status", "queued");
      if (error) throw new Error(`Run cancelled, but queued rows could not be closed: ${error.message}`);
      return `Run ${command.run_id} остановлен; оставшиеся queued-кандидаты отменены.`;
    }
  }
}

async function finish(id: string, token: string, result: string | null, errorMessage: string | null) {
  const { data, error } = await db.rpc("finish_chestny_catalog_worker_command", {
    p_id: id, p_token: token, p_result: result ? { message: result } : null, p_error: errorMessage,
  });
  if (error) throw new Error(`Could not finalize command ${id}: ${error.message}`);
  if (data !== true) throw new Error(`Command ${id} lease was lost before finalization`);
}

async function acquireSingleton(path: string, token: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const record = await readFile(path, "utf8").catch(() => "");
      const pid = Number((record.match(/"pid"\s*:\s*(\d+)/) ?? [])[1]);
      let alive = true;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (probeError) { if ((probeError as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
      } else {
        const info = await stat(path).catch(() => null);
        if (!info || Date.now() - info.mtimeMs > 60_000) alive = false;
      }
      if (alive) return null;
      await unlink(path).catch(() => undefined);
    }
  }
  return null;
}

const taskRepository = new ControlTaskRepository(db);
const catalogModule = createChestnyPrigonRuntime({
  db, ownerId, chatId: Number(ownerId), executeLegacyCommand: processCommand, startInitialWave,
});
const moduleRegistry = new ModuleRegistry();
moduleRegistry.register(catalogModule);
const taskService = new ControlTaskService(taskRepository, moduleRegistry);
const taskCoordinator = new ControlTaskCoordinator(taskRepository, moduleRegistry, taskService);

async function controlTaskForCommand(command: Command) {
  let task = await taskRepository.findByExternalRef("chestny-prigon.catalog", command.run_id);
  if (task) return task;
  if (command.command !== "start") throw new Error(`No active Control Center goal is linked to run ${command.run_id}`);
  const { data: run, error } = await db.from("chestny_enrichment_runs").select("status,rules").eq("id", command.run_id).single();
  if (error) throw new Error(`Cannot bind control task to run: ${error.message}`);
  const launchId = String(run.rules?.catalogLaunchId ?? "");
  if (!launchId) throw new Error("Run is not attached to a catalog launch; refusing to create a goal task");
  const activeGoal = await taskRepository.findActiveForLaunch(launchId);
  if (activeGoal) return activeGoal;
  const initialState = run.status === "running" ? "running" : run.status === "paused" ? "paused"
    : run.status === "cancelled" ? "cancelled" : run.status === "completed" ? "ready" : "ready";
  task = await taskRepository.create({
    moduleId: "chestny-prigon.catalog", product: "chestny-prigon", source: "encar",
    goal: "Найти, обработать и подготовить к публикации 1 000 новых автомобилей по утверждённым квотам",
    externalRef: command.run_id, state: initialState,
    parameters: { launchId, targetPublications: 1_000, pilotApproved: false, publishAuthorized: false, maxItemsPerWave: 50 },
    progress: { stage: "queued", intent: command.command, currentRunId: command.run_id, waveNumber: 0 },
  });
  return task;
}

function moduleAction(command: Command["command"]) {
  return command === "start" ? "run" : command === "resume" ? "resume" : command;
}

async function main() {
  const lockDirectory = "/tmp/encar-coordination";
  await mkdir(lockDirectory, { recursive: true });
  const singletonPath = join(lockDirectory, "chestny-catalog-control.lock");
  const singletonToken = randomUUID();
  const handle = await acquireSingleton(singletonPath, singletonToken);
  if (!handle) return;

  try {
    const leaseToken = randomUUID();
    for (let count = 0; count < 20; count += 1) {
      const { data, error } = await db.rpc("claim_chestny_catalog_worker_command", { p_token: leaseToken, p_lease_seconds: 90 });
      if (error) {
        console.error(`Cannot claim Telegram command; continue progress monitoring: ${error.message}`);
        break;
      }
      if (!data || typeof data !== "object") break;
      const command = data as Command;
      let resultMessage: string;
      try {
        const task = await controlTaskForCommand(command);
        if (task) {
          await taskRepository.update(task.id, { progress: { ...task.progress, intent: command.command, stage: "owner_command", currentRunId: command.run_id } });
          const dispatched = await taskService.invoke(moduleAction(command.command), task.id);
          resultMessage = dispatched.result.summary;
        } else {
          resultMessage = await processCommand(command);
        }
        await finish(command.id, leaseToken, resultMessage, null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await finish(command.id, leaseToken, null, message);
        resultMessage = `Команда ${command.command} для run ${command.run_id} не выполнена: ${message}`;
      }
      try { await sendTelegram(command.telegram_chat_id, resultMessage); }
      catch (error) { console.error(`Could not send command notification: ${error instanceof Error ? error.message : String(error)}`); }
    }
    let coordinated: Awaited<ReturnType<typeof taskCoordinator.tick>> = [];
    try { coordinated = await taskCoordinator.tick(3); }
    catch (error) { console.error(`Could not tick catalog coordinator: ${error instanceof Error ? error.message : String(error)}`); }
    for (const item of coordinated) {
      if (item.error) {
        const message = `⚠️ Задача каталога приостановлена. Этап: ${item.stage}. Причина: ${item.error.slice(0, 700)}`;
        try { await sendTelegram(Number(ownerId), message); }
        catch (error) { console.error(`Could not report coordinator progress: ${error instanceof Error ? error.message : String(error)}`); }
      } else if (item.action === "run" && item.stage === "publish_wave") {
        try {
          const task = await taskRepository.get(item.taskId);
          await sendTelegram(Number(ownerId), publicationReport(task.result ?? {}));
        } catch (error) {
          console.error(`Could not report publication outcome: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    try { await recoverInterruptedLocalWorker(); }
    catch (error) { console.error(`Could not recover interrupted local worker: ${error instanceof Error ? error.message : String(error)}`); }
    try { await monitorCatalogProgress(); }
    catch (error) { console.error(`Could not notify catalog progress: ${error instanceof Error ? error.message : String(error)}`); }
  } finally {
    await handle.close();
    const current = await readFile(singletonPath, "utf8").catch(() => "");
    if (current.includes(singletonToken)) {
      await unlink(singletonPath).catch(() => undefined);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
