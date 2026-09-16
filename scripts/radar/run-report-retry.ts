import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fetch, ProxyAgent } from "undici";
import { readFile } from "node:fs/promises";

config({ path: ".env", quiet: true });
const runId = process.env.CHESTNY_REPORT_RETRY_RUN_ID;
const batchSize = Math.min(50, Math.max(1, Number(process.env.CHESTNY_REPORT_RETRY_BATCH_SIZE ?? 50)));
const delayMs = Math.max(1_000, Number(process.env.CHESTNY_REPORT_RETRY_DELAY_MS ?? 3_000));
const dryRun = process.env.CHESTNY_REPORT_RETRY_DRY_RUN === "true";
const proxyUrl = process.env.ENCAR_PROXY_URL?.trim();
const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`Missing ${name}`); return value; };
type Row = { id: string; source_listing_id: string; candidate_snapshot: Record<string, unknown> };
type Probe = { ok: boolean; status?: number; body?: unknown; error?: string };
type Classification = "ready" | "report_not_found" | "timeout" | "http_error" | "captcha" | "blocked" | "proxy_error";
const agent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
const radarPath = `${process.env.ENCAR_COORDINATION_DIR ?? "/tmp/encar-coordination"}/radar-priority.json`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const idOf = (row: Row) => String(row.candidate_snapshot.encarId ?? row.source_listing_id);

function classify(probe: Probe): Classification {
  if (probe.ok) return "ready";
  if (/captcha/i.test(probe.error ?? "")) return "captcha";
  if (/proxy|socket|econn|eai_again|fetch failed/i.test(probe.error ?? "")) return "proxy_error";
  if (/timeout|abort|timed out/i.test(probe.error ?? "")) return "timeout";
  if (probe.status === 403 || probe.status === 429 || probe.status === 503) return "blocked";
  if (probe.status === 404 || probe.status === 410) return "report_not_found";
  return "http_error";
}
async function probe(url: string): Promise<Probe> {
  try { const response = await fetch(url, { headers: { Accept: "application/json", Origin: "https://fem.encar.com", Referer: "https://fem.encar.com/" }, ...(agent ? { dispatcher: agent } : {}), signal: AbortSignal.timeout(20_000) }); if (!response.ok) return { ok: false, status: response.status }; return { ok: true, status: response.status, body: await response.json() }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
async function main() {
  if (!runId) throw new Error("CHESTNY_REPORT_RETRY_RUN_ID is required");
  if (!proxyUrl) throw new Error("ENCAR_PROXY_URL is required; direct requests are disabled");
  const db = createClient<any>(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: rows, error } = dryRun ? await db.from("chestny_enrichment_queue").select("id,source_listing_id,candidate_snapshot").eq("run_id", runId).eq("status", "queued").order("created_at").limit(batchSize) : await db.rpc("claim_chestny_enrichment_queue", { p_run_id: runId, p_limit: batchSize, p_lease_minutes: 30 });
  if (error) throw new Error(error.message);
  const results: Record<string, unknown>[] = [];
  for (const [index, row] of ((rows ?? []) as Row[]).entries()) {
    if (!dryRun && await radarHasPriority()) {
      const remaining = ((rows ?? []) as Row[]).slice(index).map((item) => item.id);
      if (remaining.length) await db.from("chestny_enrichment_queue").update({ status: "queued", lease_until: null, updated_at: new Date().toISOString() }).in("id", remaining);
      break;
    }
    const id = idOf(row);
    const [inspection, summary] = await Promise.all([probe(`https://api.encar.com/v1/readside/inspection/vehicle/${id}`), probe(`https://api.encar.com/v1/readside/inspection/vehicle/${id}/summary`)]);
    const inspectionClassification = classify(inspection); const summaryClassification = classify(summary);
    const classification = inspection.ok ? "ready" : inspectionClassification;
    const result = { encarId: id, classification, inspectionStatus: inspection.status ?? null, summaryStatus: summary.status ?? null, inspectionError: inspection.error ?? null, summaryError: summary.error ?? null, inspectionAvailable: inspection.ok, summaryAvailable: summary.ok };
    if (!dryRun) { const status = classification === "report_not_found" ? "unavailable" : inspection.ok || summary.ok ? "succeeded" : "failed"; const done = await db.rpc("complete_chestny_enrichment_queue_item", { p_queue_id: row.id, p_status: status, p_result: result, p_payload: { retry: true, inspection: inspection.body ?? null, inspectionSummary: summary.body ?? null, fetchedAt: new Date().toISOString(), classification }, p_error: status === "failed" ? classification : null }); if (done.error) throw new Error(done.error.message); }
    results.push({ sourceListingId: row.source_listing_id, ...result }); await sleep(delayMs);
  }
  console.log(JSON.stringify({ runId, dryRun, batchSize, requested: results.length, onlyEndpoints: ["inspection", "summary"], results: results.length <= 10 ? results : undefined }, null, 2)); await agent!.close();
}
async function radarHasPriority() {
  try { const owner = JSON.parse(await readFile(radarPath, "utf8")) as { pid?: number }; if (!Number.isInteger(owner.pid)) return false; try { process.kill(owner.pid!, 0); return true; } catch { return false; } } catch { return false; }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
