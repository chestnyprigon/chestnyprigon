import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient;
const lockName = "chestny-catalog-enrichment";
const leaseSeconds = 120;
const heartbeatMs = 30_000;

type LockFile = { pid: number; token: string; host: string; startedAt: string };

async function processIsAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function acquireFileLock(path: string, token: string) {
  await mkdir(path, { recursive: true });
  const lockPath = join(path, `${lockName}.lock`);
  const payload: LockFile = { pid: process.pid, token, host: hostname(), startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify(payload));
      await handle.close();
      return { lockPath, payload };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: LockFile | null = null;
      try { owner = JSON.parse(await readFile(lockPath, "utf8")) as LockFile; } catch { /* incomplete lock is handled below */ }
      const lockStat = await stat(lockPath).catch(() => null);
      const staleMalformedFile = !owner && lockStat !== null && Date.now() - lockStat.mtimeMs > leaseSeconds * 1_000;
      const alive = owner && owner.host === hostname() && Number.isInteger(owner.pid)
        ? await processIsAlive(owner.pid)
        : owner ? true : !staleMalformedFile;
      if (alive) throw new Error(`Enrichment worker already holds the local lock (${owner?.pid ?? "owner unknown"})`);
      await unlink(lockPath).catch(() => undefined);
    }
  }
  throw new Error("Could not acquire the local enrichment worker lock");
}

async function refreshDatabaseLock(db: Db, token: string, runId: string) {
  const { data, error } = await db.rpc("acquire_chestny_enrichment_worker_lock", {
    p_token: token, p_run_id: runId, p_host: hostname(), p_lease_seconds: leaseSeconds,
  });
  if (error) throw new Error(`Enrichment worker lock RPC failed (apply the step 5 migration first): ${error.message}`);
  if (data !== true) throw new Error("Another Encar enrichment worker holds the global Supabase lock");
}

export async function withEnrichmentWorkerLock<T>(input: {
  db: Db;
  runId: string;
  task: (token: string, signal: AbortSignal) => Promise<T>;
  inheritedToken?: string;
}) {
  const inherited = input.inheritedToken?.trim() || null;
  const token = inherited ?? randomUUID();
  const coordinationDirectory = process.env.ENCAR_COORDINATION_DIR?.trim() || "/tmp/encar-coordination";
  const fileLock = inherited ? null : await acquireFileLock(coordinationDirectory, token);
  let heartbeatFailure: Error | null = null;
  const abortController = new AbortController();
  try {
    await refreshDatabaseLock(input.db, token, input.runId);
  } catch (error) {
    if (fileLock) await unlink(fileLock.lockPath).catch(() => undefined);
    throw error;
  }
  const heartbeat = setInterval(() => {
    void refreshDatabaseLock(input.db, token, input.runId).catch((error) => {
      heartbeatFailure = error instanceof Error ? error : new Error(String(error));
      abortController.abort(heartbeatFailure);
    });
  }, heartbeatMs);
  heartbeat.unref();
  try {
    const result = await input.task(token, abortController.signal);
    if (heartbeatFailure) throw heartbeatFailure;
    return result;
  } finally {
    clearInterval(heartbeat);
    if (!inherited) {
      const { error } = await input.db.rpc("release_chestny_enrichment_worker_lock", { p_token: token });
      if (error) console.error(`Could not release Supabase worker lock: ${error.message}`);
      if (fileLock) {
        try {
          const current = JSON.parse(await readFile(fileLock.lockPath, "utf8")) as LockFile;
          if (current.token === token && current.pid === process.pid) await unlink(fileLock.lockPath);
        } catch { /* lock file may already have been recovered */ }
      }
    }
  }
}
