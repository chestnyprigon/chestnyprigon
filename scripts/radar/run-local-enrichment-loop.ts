import { spawn } from "node:child_process";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local", quiet: true });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const runId = process.argv.find((argument) => argument.startsWith("--run-id="))?.slice("--run-id=".length);
if (!runId || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(runId)) throw new Error("--run-id must be a run UUID");

const batchSize = 10;
const delayMs = 7_000;
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
  for (const status of ["queued", "leased", "succeeded", "unavailable", "failed"]) {
    const { count, error } = await client.from("chestny_enrichment_queue")
      .select("id", { count: "exact", head: true })
      .eq("run_id", runId)
      .eq("status", status);
    if (error) throw new Error(error.message);
    counts[status] = count ?? 0;
  }
  return counts;
}

async function runBatch(): Promise<WorkerResult> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("npm", ["run", "radar:vps-enrichment"], {
      env: {
        ...process.env,
        CHESTNY_ENRICHMENT_DIRECT: "true",
        CHESTNY_ENRICHMENT_RUN_ID: runId,
        CHESTNY_ENRICHMENT_BATCH_SIZE: String(batchSize),
        CHESTNY_ENRICHMENT_DELAY_MS: String(delayMs),
        CHESTNY_ENRICHMENT_MAX_ATTEMPTS: "3",
      },
      stdio: ["ignore", "pipe", "pipe"],
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

async function main() {
  let batch = 0;
  while (true) {
    const result = await runBatch();
    batch += 1;
    const counts = await queueCounts();
    console.log(JSON.stringify({ runId, batch, transport: "direct", ...counts }));
    if (result.results.some((item) => /HTTP (403|429)|captcha|verification/i.test(item.error ?? "")
      || /^(endpoint_(transient_error|auth_error|blocked|rate_limited)|transient_request|auth_error|blocked|rate_limited)$/.test(item.failureClass ?? ""))) {
      throw new Error("Encar access restriction detected; local enrichment paused");
    }
    if (result.claimed > 0 && result.failed >= Math.ceil(result.claimed / 2)) {
      throw new Error("At least half the batch failed; local enrichment paused");
    }
    if (counts.queued === 0 && counts.leased === 0) break;
    if (result.claimed === 0) throw new Error("Queue has pending or leased items but the worker claimed none");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
