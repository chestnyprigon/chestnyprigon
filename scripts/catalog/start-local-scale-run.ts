import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

config({ path: ".env.local", quiet: true });

const runIdArgument = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice("--run-id=".length)?.trim();
const capacity = Number(process.argv.find((arg) => arg.startsWith("--wave-capacity="))?.slice("--wave-capacity=".length) ?? 500);
if (!runIdArgument || !/^[0-9a-f-]{36}$/i.test(runIdArgument)) throw new Error("Pass a valid --run-id");
const runId = runIdArgument;
if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) throw new Error("--wave-capacity must be 1..500");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url?.includes("ojnybjomttolhsfgkdqq") || !key) throw new Error("Expected Chestny Prigon production Supabase configuration");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const stateDir = join(homedir(), "Library", "Application Support", "chestny-prigon");
const activeRunFile = join(stateDir, "active-run");
const waveSizeFile = join(stateDir, "active-wave-size");
const transportFile = join(stateDir, "active-transport");

async function count(run: string, status: string) {
  const result = await db.from("chestny_enrichment_queue").select("id", { count: "exact", head: true })
    .eq("run_id", run).eq("status", status);
  if (result.error) throw new Error(`Could not count ${status}: ${result.error.message}`);
  return result.count ?? 0;
}

async function main() {
  const marker = (await readFile(activeRunFile, "utf8").catch(() => "")).trim();
  if (marker) throw new Error(`Mac mini already has active-run ${marker}; refusing a second worker`);
  const transport = (await readFile(transportFile, "utf8").catch(() => "")).trim();
  if (transport !== "direct") throw new Error(`Expected active transport direct, found ${transport || "missing"}`);

  const now = new Date().toISOString();
  const lock = await db.from("chestny_enrichment_worker_lock").select("run_id,expires_at")
    .eq("lock_name", "chestny-catalog-enrichment").gt("expires_at", now).maybeSingle();
  if (lock.error) throw new Error(`Could not verify global worker lock: ${lock.error.message}`);
  if (lock.data) throw new Error(`Encar worker lock is held by ${lock.data.run_id}`);

  const run = await db.from("chestny_enrichment_runs").select("id,status,candidate_count,rules")
    .eq("id", runId).single();
  if (run.error) throw new Error(`Could not read run: ${run.error.message}`);
  const rules = run.data.rules as Record<string, unknown>;
  if (run.data.status !== "approved" || rules.transport !== "direct" || rules.publication !== "disabled"
    || rules.discoveryOnly !== true || !rules.catalogLaunchId) {
    throw new Error("Run must be approved, direct, discovery-only, and have publication disabled");
  }
  if (run.data.candidate_count < 1 || run.data.candidate_count > 5_000) {
    throw new Error(`Expected up to 5,000 newly discovered candidates, found ${run.data.candidate_count}`);
  }
  const queued = await count(runId, "queued");
  const leased = await count(runId, "leased");
  const terminal = (await Promise.all(["succeeded", "unavailable", "failed", "cancelled"].map((status) => count(runId, status))))
    .reduce((sum, value) => sum + value, 0);
  if (queued !== run.data.candidate_count || leased || terminal) {
    throw new Error(`Expected a wholly queued run; queued=${queued}, leased=${leased}, terminal=${terminal}, candidate_count=${run.data.candidate_count}`);
  }

  const plan = await db.rpc("plan_chestny_enrichment_waves", {
    p_run_id: runId,
    p_safe_wave_capacity: capacity,
    p_plan: { source: "macmini_scale_run", transport: "direct", publication: "disabled", brandDiversity: "approved_remaining_quota_weights" },
  });
  if (plan.error) throw new Error(`Could not persist balanced waves: ${plan.error.message}`);

  const updated = await db.from("chestny_enrichment_runs").update({ status: "running", started_at: now })
    .eq("id", runId).eq("status", "approved").select("id").maybeSingle();
  if (updated.error) throw new Error(`Could not mark run as running: ${updated.error.message}`);
  if (!updated.data) throw new Error("Run status changed during startup");

  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(activeRunFile, runId, { mode: 0o600, flag: "wx" });
    await writeFile(waveSizeFile, String(capacity), { mode: 0o600 });
    await writeFile(transportFile, "direct", { mode: 0o600 });
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Could not determine macOS GUI user id");
    const kick = spawnSync("/bin/launchctl", ["kickstart", `gui/${uid}/com.chestnyprigon.catalog-worker`], { encoding: "utf8" });
    if (kick.status !== 0) throw new Error(`Could not start worker LaunchAgent (exit ${kick.status ?? "unknown"})`);
  } catch (error) {
    await unlink(activeRunFile).catch(() => undefined);
    await unlink(waveSizeFile).catch(() => undefined);
    await db.from("chestny_enrichment_runs").update({ status: "approved", started_at: null })
      .eq("id", runId).eq("status", "running").then(() => undefined);
    throw error;
  }

  console.log(JSON.stringify({ started: true, runId, candidateCount: run.data.candidate_count,
    transport: "direct_home_network", publication: "disabled", wavePlan: plan.data }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
