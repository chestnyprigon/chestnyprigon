import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { readTelegramBotToken } from "./telegram-keychain";

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
  const existing = await readFile(activeRunFile, "utf8").catch(() => "");
  if (existing.trim() && existing.trim() !== command.run_id) throw new Error(`Another run ${existing.trim()} is already marked active`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (!existing.trim()) await writeFile(activeRunFile, command.run_id, { mode: 0o600, flag: "wx" });
  try {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Could not determine macOS GUI user id");
    const kick = spawnSync("/bin/launchctl", ["kickstart", `gui/${uid}/com.chestnyprigon.catalog-worker`], { encoding: "utf8" });
    if (kick.status !== 0) throw new Error(`Could not start worker LaunchAgent (exit ${kick.status ?? "unknown"})`);
  } catch (error) {
    if (!existing.trim()) await unlink(activeRunFile).catch(() => undefined);
    throw error;
  }
}

async function searchNextWave() {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("npm", ["run", "--silent", "catalog:search-local", "--", "--apply", "--pilot-candidates=50"], {
      cwd: process.cwd(),
      env: process.env,
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
  await setRunStatus(command.run_id, "running", ["approved"]);
  try {
    await startWorker(command);
  } catch (error) {
    const marker = await readFile(activeRunFile, "utf8").catch(() => "");
    if (marker.trim() === command.run_id) await unlink(activeRunFile).catch(() => undefined);
    await setRunStatus(command.run_id, "approved", ["running"]).catch(() => undefined);
    throw error;
  }
}

async function processCommand(command: Command) {
  if (String(command.telegram_user_id) !== ownerId) throw new Error("Command owner does not match the configured Telegram owner");
  if (command.max_items < 1 || command.max_items > 50) throw new Error("Command exceeds the approved 50-item wave limit");

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

          await sendTelegram(command.telegram_chat_id, "Ищу следующую волну по незакрытым квотам. Поиск идёт последовательно, offset сохраняется после каждой страницы; после поиска начнутся обогащение и screening. Публикация отключена.").catch(() => undefined);
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
          await startPreparedRun({ ...command, run_id: search.runId });
          return `Поиск завершён: в run ${search.runId} добавлено ${queuedCount} новых кандидатов. Worker запущен; после обогащения выполнится screening. Публикации нет.`;
        }
        if (current.status !== "approved") throw new Error(`Run ${command.run_id} has status ${current.status}; it is not ready to start`);
        await startPreparedRun(command);
        return `Начата обработка подготовленной волны run ${command.run_id}, лимит ${command.max_items}. Новые объявления не ищутся; публикации нет.`;
      }
    case "resume":
      await setRunStatus(command.run_id, "running", ["paused"]);
      try {
        await startWorker(command);
      } catch (error) {
        const marker = await readFile(activeRunFile, "utf8").catch(() => "");
        if (marker.trim() === command.run_id) await unlink(activeRunFile).catch(() => undefined);
        await setRunStatus(command.run_id, "paused", ["running"]).catch(() => undefined);
        throw error;
      }
      return `Волна run ${command.run_id} возобновлена; лимит — ${command.max_items}. После обработки автоматически выполняется screening. Публикация не запускается.`;
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
      if (error) throw new Error(`Cannot claim Telegram command: ${error.message}`);
      if (!data || typeof data !== "object") break;
      const command = data as Command;
      let resultMessage: string;
      try {
        resultMessage = await processCommand(command);
        await finish(command.id, leaseToken, resultMessage, null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await finish(command.id, leaseToken, null, message);
        resultMessage = `Команда ${command.command} для run ${command.run_id} не выполнена: ${message}`;
      }
      try { await sendTelegram(command.telegram_chat_id, resultMessage); }
      catch (error) { console.error(`Could not send command notification: ${error instanceof Error ? error.message : String(error)}`); }
    }
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
