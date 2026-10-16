import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { CATALOG_POLICY } from "../encar/catalog-policy";
import { readEncarProxyUrlFromKeychain } from "../encar/proxy";
import { createDomesticQuery, fetchDirectSearchPage } from "../encar/client";

config({ path: ".env.local", quiet: true });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env.local`);
  return value;
}

async function main() {
  const transportArgument = process.argv.find((item) => item.startsWith("--transport="))?.slice("--transport=".length);
  const directCheckOnly = process.argv.includes("--direct-check-only");
  const proxyCheckOnly = process.argv.includes("--proxy-check-only");
  const directNetworkCheckOnly = process.argv.includes("--direct-network-check-only");
  const transport = transportArgument ?? (proxyCheckOnly ? "proxy" : directCheckOnly || directNetworkCheckOnly ? "direct" : undefined);
  if (transport !== "direct" && transport !== "proxy") throw new Error("Choose an explicit --transport=direct or --transport=proxy");
  const runId = process.argv.find((item) => item.startsWith("--run-id="))?.slice("--run-id=".length);
  if ([directCheckOnly, proxyCheckOnly, directNetworkCheckOnly].filter(Boolean).length > 1) throw new Error("Choose only one check-only mode");
  if (directCheckOnly && transport !== "direct") throw new Error("--direct-check-only requires --transport=direct");
  if (proxyCheckOnly && transport !== "proxy") throw new Error("--proxy-check-only requires --transport=proxy");
  if (directNetworkCheckOnly) {
    if (transport !== "direct" || runId) throw new Error("Network check requires direct transport and no --run-id; it never starts a run");
    const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: lock, error } = await db.from("chestny_enrichment_worker_lock").select("run_id")
      .eq("lock_name", "chestny-catalog-enrichment").gt("expires_at", new Date().toISOString()).maybeSingle();
    if (error) throw new Error(`Could not inspect worker lock: ${error.message}`);
    if (lock) throw new Error(`Network check blocked: worker is active for run ${lock.run_id}`);
    for (const name of ["ENCAR_PROXY_URL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"]) delete process.env[name];
    const page = await fetchDirectSearchPage({ offset: 0, limit: 1,
      query: createDomesticQuery(CATALOG_POLICY.minYear, new Date().getFullYear(), CATALOG_POLICY.maxMileageKm),
      verifyAccess: false });
    console.log(JSON.stringify({ preflight: "direct_network_ready", transport: "direct_home_network",
      networkConnectivityChecked: true, proxyCredentialRead: false, proxyDispatcherUsed: false,
      encarRequestsMade: 1, searchResultsReceived: page.listings.length,
      queueClaimsMade: 0, databaseWritesMade: 0, publicationAttempted: false }, null, 2));
    return;
  }

  if (directCheckOnly) {
    if (runId) {
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(runId)) throw new Error("--run-id must be a run UUID");
      const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: run, error } = await db.from("chestny_enrichment_runs").select("id,status,rules,candidate_count").eq("id", runId).single();
      if (error) throw new Error(`Could not read run during preflight: ${error.message}`);
      if (!(["approved", "running", "paused"] as string[]).includes(run.status)) throw new Error(`Run status ${run.status} is not eligible for a worker`);
      if (run.rules?.transport !== "direct") throw new Error(`Run transport is ${String(run.rules?.transport ?? "unset")}; direct preflight requires a run saved as direct`);
      const { data: lock, error: lockError } = await db.from("chestny_enrichment_worker_lock")
        .select("run_id,expires_at").eq("lock_name", "chestny-catalog-enrichment").gt("expires_at", new Date().toISOString()).maybeSingle();
      if (lockError) throw new Error(`Could not inspect active worker lock: ${lockError.message}`);
      const queue: Record<string, number> = {};
      for (const status of ["queued", "leased"]) {
        const result = await db.from("chestny_enrichment_queue").select("id", { count: "exact", head: true })
          .eq("run_id", runId).eq("status", status);
        if (result.error) throw new Error(`Could not count ${status} work: ${result.error.message}`);
        queue[status] = result.count ?? 0;
      }
      console.log(JSON.stringify({ preflight: lock ? "blocked_by_active_worker" : "passed", runId, runStatus: run.status,
        candidateCount: run.candidate_count, queue, transport: "direct_home_network", proxyCredentialRead: false,
        proxyDispatcherUsed: false, activeWorkerRunId: lock?.run_id ?? null,
        encarRequestsMade: 0, queueClaimsMade: 0, publicationAttempted: false }, null, 2));
      if (lock) throw new Error(`An Encar worker holds the global lock for run ${lock.run_id}`);
      return;
    }
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
    if (runId) {
      if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(runId)) throw new Error("--run-id must be a run UUID");
      const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: run, error } = await db.from("chestny_enrichment_runs").select("id,status,rules,candidate_count").eq("id", runId).single();
      if (error) throw new Error(`Could not read run during preflight: ${error.message}`);
      if (run.rules?.transport !== "proxy") throw new Error(`Run transport is ${String(run.rules?.transport ?? "unset")}; proxy preflight requires a run saved as proxy`);
      const { data: lock, error: lockError } = await db.from("chestny_enrichment_worker_lock")
        .select("run_id,expires_at").eq("lock_name", "chestny-catalog-enrichment").gt("expires_at", new Date().toISOString()).maybeSingle();
      if (lockError) throw new Error(`Could not inspect active worker lock: ${lockError.message}`);
      console.log(JSON.stringify({ preflight: lock ? "blocked_by_active_worker" : "proxy_credential_ready", runId,
        runStatus: run.status, candidateCount: run.candidate_count, transport: "decodo_proxy",
        proxyEndpoint: new URL(proxyUrl!).host, proxyDispatcherUsed: true, activeWorkerRunId: lock?.run_id ?? null,
        encarRequestsMade: 0, queueClaimsMade: 0, publicationAttempted: false }, null, 2));
      if (lock) throw new Error(`An Encar worker holds the global lock for run ${lock.run_id}`);
      return;
    }
    console.log(JSON.stringify({ preflight: "proxy_credential_ready", transport: "decodo_proxy", proxyEndpoint: new URL(proxyUrl!).host, encarRequestsMade: 0 }, null, 2));
    return;
  }
  if (!runId || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(runId)) throw new Error("--run-id must be a run UUID");

  const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: run, error: runError } = await db.from("chestny_enrichment_runs")
    .select("id,status,candidate_count,rules").eq("id", runId).single();
  if (runError) throw new Error(runError.message);
  if (!(run.status === "approved" || run.status === "running")) throw new Error(`Run status ${run.status} is not eligible for a worker`);
  if (run.rules?.transport !== transport) throw new Error(`Run transport is ${String(run.rules?.transport ?? "unset")}; requested preflight transport is ${transport}`);
  const targetedReportRefresh = run.rules?.type === "targeted_report_refresh";
  const { data: waves, error: waveError } = await db.from("chestny_enrichment_waves")
    .select("id,wave_number,candidate_count,status").eq("run_id", runId).order("wave_number");
  if (waveError) throw new Error(`Could not inspect saved waves: ${waveError.message}`);

  const counts: Record<string, number> = {};
  for (const status of ["queued", "leased"]) {
    const { count, error } = await db.from("chestny_enrichment_queue")
      .select("id", { count: "exact", head: true }).eq("run_id", runId).eq("status", status);
    if (error) throw new Error(error.message);
    counts[status] = count ?? 0;
  }

  const { data: lock, error: lockError } = await db.from("chestny_enrichment_worker_lock")
    .select("run_id,expires_at").eq("lock_name", "chestny-catalog-enrichment")
    .gt("expires_at", new Date().toISOString()).maybeSingle();
  if (lockError) throw new Error(`Could not inspect active worker lock: ${lockError.message}`);
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
      processingScope: waves?.length ? "all_persisted_waves" : "requires_explicit_worker_limit",
      savedWaves: waves ?? [],
      maxItemsPerInvocation: waves?.length ? null : targetedReportRefresh ? 5_000 : 50,
      maxQueueClaimSize: targetedReportRefresh ? 1 : 10,
      concurrentListings: targetedReportRefresh ? 2 : 1,
      perListingConcurrency: 1,
      requestDelayMs: targetedReportRefresh ? 2_000 : CATALOG_POLICY.requestDelayMs,
      maxEndpointAttempts: CATALOG_POLICY.maxEndpointAttempts,
      encarRequestsMade: 0,
      queueClaimsMade: 0,
      publicationAttempted: false,
      activeWorkerRunId: lock?.run_id ?? null,
    }, null, 2));
  if (lock) throw new Error(`An Encar worker holds the global lock for run ${lock.run_id}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
