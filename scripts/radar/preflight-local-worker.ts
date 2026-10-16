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
  const transportArgument = process.argv.find((item) => item.startsWith("--transport="))?.slice("--transport=".length);
  const transport = transportArgument ?? "proxy";
  if (transport !== "direct" && transport !== "proxy") throw new Error("--transport must be direct or proxy");
  const directCheckOnly = process.argv.includes("--direct-check-only");
  const proxyCheckOnly = process.argv.includes("--proxy-check-only");
  if (directCheckOnly && proxyCheckOnly) throw new Error("Choose only one of --direct-check-only or --proxy-check-only");
  if (directCheckOnly && transport !== "direct") throw new Error("--direct-check-only requires --transport=direct");
  if (proxyCheckOnly && transport !== "proxy") throw new Error("--proxy-check-only requires --transport=proxy");

  if (directCheckOnly) {
    console.log(JSON.stringify({
      preflight: "direct_transport_ready",
      transport: "direct_home_network",
      proxyCredentialRead: false,
      proxyDispatcherUsed: false,
      networkConnectivityChecked: false,
      encarRequestsMade: 0,
    }, null, 2));
    return;
  }

  const proxyUrl = transport === "proxy" ? readEncarProxyUrlFromKeychain() : undefined;
  if (proxyCheckOnly) {
    console.log(JSON.stringify({ preflight: "proxy_credential_ready", transport: "decodo_proxy", proxyEndpoint: new URL(proxyUrl!).host, encarRequestsMade: 0 }, null, 2));
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
      transport: transport === "direct" ? "direct_home_network" : "decodo_proxy",
      proxyCredential: transport === "proxy" ? "available in login Keychain" : "not read",
      ...(proxyUrl ? { proxyEndpoint: new URL(proxyUrl).host } : {}),
      proxyDispatcherUsed: transport === "proxy",
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
