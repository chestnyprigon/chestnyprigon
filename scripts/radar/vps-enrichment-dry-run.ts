import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { ProxyAgent, fetch as undiciFetch } from "undici";

config({ path: ".env.local", quiet: true });

const runId = process.env.CHESTNY_ENRICHMENT_RUN_ID ?? "ebe8fa15-1732-4a0d-876f-b1a9a05556f7";
const limit = Math.min(50, Math.max(1, Number(process.env.CHESTNY_ENRICHMENT_BATCH_SIZE ?? 50)));
const delayMs = Math.max(1_000, Number(process.env.CHESTNY_ENRICHMENT_DELAY_MS ?? 3_000));
const proxyUrl = process.env.ENCAR_PROXY_URL?.trim();

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!proxyUrl) throw new Error("ENCAR_PROXY_URL is required; direct requests are disabled");
  const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: run, error: runError } = await db.from("chestny_enrichment_runs").select("id,status,candidate_count").eq("id", runId).single();
  if (runError) throw new Error(runError.message);
  if (run.status !== "approved") throw new Error(`Run ${runId} must be approved (status=${run.status})`);
  const { data: rows, error: queueError } = await db.from("chestny_enrichment_queue")
    .select("source_listing_id,candidate_snapshot")
    .eq("run_id", runId).eq("status", "queued").order("created_at").limit(limit);
  if (queueError) throw new Error(queueError.message);
  const agent = new ProxyAgent(proxyUrl);
  const results: Array<Record<string, unknown>> = [];
  let bytes = 0;
  try {
    for (const row of rows ?? []) {
      const snapshot = (row.candidate_snapshot ?? {}) as Record<string, unknown>;
      const encarId = String(snapshot.sourceListingId ?? row.source_listing_id);
      try {
        const response = await undiciFetch(`https://api.encar.com/v1/readside/vehicle/${encodeURIComponent(encarId)}`, {
          headers: { Accept: "application/json", Origin: "https://fem.encar.com", Referer: "https://fem.encar.com/" },
          dispatcher: agent,
          signal: AbortSignal.timeout(20_000),
        });
        const body = await response.text();
        bytes += Buffer.byteLength(body);
        results.push({ sourceListingId: row.source_listing_id, encarId, status: response.status === 404 || response.status === 410 ? "unavailable" : response.ok ? "active" : "error", httpStatus: response.status, responseBytes: Buffer.byteLength(body) });
      } catch (error) {
        results.push({ sourceListingId: row.source_listing_id, encarId, status: "error", error: error instanceof Error ? error.message : String(error) });
      }
      await sleep(delayMs);
    }
  } finally { await agent.close(); }
  console.log(JSON.stringify({ runId, mode: "dry-run", requested: rows?.length ?? 0, writes: 0, published: 0, bytes, mebibytes: Number((bytes / 1024 / 1024).toFixed(3)), active: results.filter((r) => r.status === "active").length, unavailable: results.filter((r) => r.status === "unavailable").length, errors: results.filter((r) => r.status === "error").length, results }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
