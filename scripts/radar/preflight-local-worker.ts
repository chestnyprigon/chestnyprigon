import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { CATALOG_POLICY } from "../encar/catalog-policy";
import { readEncarProxyUrlFromKeychain } from "../encar/proxy";
import { withEnrichmentWorkerLock } from "./enrichment-worker-lock";

config({ path: ".env.local", quiet: true });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env.local`);
  return value;
}

async function main() {
  const proxyUrl = readEncarProxyUrlFromKeychain();
  if (process.argv.includes("--proxy-check-only")) {
    console.log(JSON.stringify({ preflight: "proxy_credential_ready", transport: "decodo_proxy", proxyEndpoint: new URL(proxyUrl).host, encarRequestsMade: 0 }, null, 2));
    return;
  }
  const runId = process.argv.find((item) => item.startsWith("--run-id="))?.slice("--run-id=".length);
  if (!runId || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(runId)) throw new Error("--run-id must be a run UUID");

  const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: run, error: runError } = await db.from("chestny_enrichment_runs")
    .select("id,status,candidate_count,rules").eq("id", runId).single();
  if (runError) throw new Error(runError.message);
  if (!(run.status === "approved" || run.status === "running")) throw new Error(`Run status ${run.status} is not eligible for a worker`);
  const targetedReportRefresh = run.rules?.type === "targeted_report_refresh";

  const counts: Record<string, number> = {};
  for (const status of ["queued", "leased"]) {
    const { count, error } = await db.from("chestny_enrichment_queue")
      .select("id", { count: "exact", head: true }).eq("run_id", runId).eq("status", status);
    if (error) throw new Error(error.message);
    counts[status] = count ?? 0;
  }

  await withEnrichmentWorkerLock({ db, runId, task: async () => {
    console.log(JSON.stringify({
      preflight: "passed",
      runId,
      runStatus: run.status,
      candidateCount: run.candidate_count,
      queue: counts,
      transport: "decodo_proxy",
      proxyCredential: "available in login Keychain",
      proxyEndpoint: new URL(proxyUrl).host,
      maxItemsPerInvocation: targetedReportRefresh ? 5_000 : 50,
      queueClaimSize: targetedReportRefresh ? 1 : 10,
      concurrentListings: targetedReportRefresh ? 2 : 1,
      perListingConcurrency: 1,
      requestDelayMs: targetedReportRefresh ? 2_000 : CATALOG_POLICY.requestDelayMs,
      maxEndpointAttempts: CATALOG_POLICY.maxEndpointAttempts,
      encarRequestsMade: 0,
      queueClaimsMade: 0,
      publicationAttempted: false,
    }, null, 2));
  } });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
