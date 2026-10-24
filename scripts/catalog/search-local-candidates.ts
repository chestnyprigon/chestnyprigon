import { searchExclusionReasons } from "../encar/screening";
import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetchDirectSearchPage, createDomesticQuery } from "../encar/client";
import { CATALOG_POLICY } from "../encar/catalog-policy";
import { primaryManufacturerAlias } from "../encar/manufacturer-aliases";
import { planBrandSearch, type BrandSearchState } from "./resumable-search";
import { withEnrichmentWorkerLock } from "../radar/enrichment-worker-lock";
import { notifyCatalogOwner } from "../radar/telegram-catalog-notify";
import { readEncarProxyUrlFromKeychain } from "../encar/proxy";

config({ path: ".env.local", quiet: true });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function numberArgument(name: string, fallback: number, min: number, max: number) {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${name} must be ${min}..${max}`);
  return value;
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function toModelYear(value: unknown) {
  const year = Number(value);
  if (Number.isFinite(year) && year >= 190000) return Math.floor(year / 100);
  if (Number.isInteger(year) && year >= 1900 && year <= new Date().getFullYear()) return year;
  const formYear = Number(asRecord(value).FormYear);
  if (Number.isFinite(formYear) && formYear >= 190000) return Math.floor(formYear / 100);
  return Number.isInteger(formYear) && formYear >= 1900 && formYear <= new Date().getFullYear() ? formYear : null;
}

async function existingIdentifiers(client: SupabaseClient, ids: string[]) {
  const found = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    const results = await Promise.all([
      client.from("vehicles").select("source_listing_id").in("source_listing_id", chunk),
      client.from("vehicle_source_identifiers").select("source_identifier").in("source_identifier", chunk),
      client.from("encar_raw_listings").select("source_listing_id").in("source_listing_id", chunk),
      client.from("chestny_catalog_staging").select("source_listing_id").in("source_listing_id", chunk),
      client.from("chestny_discovery_reserved_queue").select("source_listing_id").in("source_listing_id", chunk),
    ]);
    for (const result of results) {
      if (result.error) throw new Error(result.error.message);
      for (const row of result.data ?? []) {
        const value = (row as { source_listing_id?: unknown; source_identifier?: unknown }).source_listing_id
          ?? (row as { source_identifier?: unknown }).source_identifier;
        if (value !== null && value !== undefined) found.add(String(value));
      }
    }
  }
  return found;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const publicationMode = process.argv.find((arg) => arg.startsWith("--publication="))?.slice("--publication=".length)
    ?? "auto_after_screening";
  if (!(publicationMode === "disabled" || publicationMode === "auto_after_screening")) {
    throw new Error("--publication must be disabled or auto_after_screening");
  }
  const pageSize = numberArgument("page-size", 100, 20, 200);
  // Scan each configured brand to source exhaustion. Brand targets only
  // influence diversity; they don't cap candidate discovery or publication.
  if (process.argv.some((arg) => arg.startsWith("--candidate-pool-target=")
    || arg.startsWith("--pilot-candidates=") || arg.startsWith("--max-pages-per-brand="))) {
    throw new Error("Candidate and page caps are no longer supported; search continues until each brand's source listing is exhausted");
  }
  const launchId = process.env.CHESTNY_CATALOG_LAUNCH_ID?.trim();
  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let launchQuery = client.from("chestny_catalog_launches").select("id,name,status,rules");
  if (launchId) launchQuery = launchQuery.eq("id", launchId);
  else launchQuery = launchQuery.in("status", ["prepared", "running"]).order("baseline_at", { ascending: false }).limit(1);
  const { data: launch, error: launchError } = await launchQuery.single();
  if (launchError) throw new Error(launchError.message);
  if (!(["prepared", "running"] as string[]).includes(launch.status)) throw new Error(`Launch status is ${launch.status}`);

  const { data: rows, error } = await client.from("chestny_catalog_brand_search_status")
    .select("manufacturer,target,published_count,search_offset,scanned_count,candidate_count,processed_candidates,conversion_rate,status,last_error,run_id")
    .eq("launch_id", launch.id).order("manufacturer");
  if (error) throw new Error(error.message);
  const processedByManufacturer = new Map<string, number>();
  const { data: cohortRuns, error: cohortError } = await client.from("chestny_enrichment_runs")
    .select("id").contains("rules", { catalogLaunchId: launch.id });
  if (cohortError) throw new Error(cohortError.message);
  const completedStatuses = ["succeeded", "unavailable", "excluded", "failed", "cancelled"];
  for (const cohortRun of cohortRuns ?? []) {
    for (let offset = 0; ; offset += 1_000) {
      const { data: queueRows, error: queueError } = await client.from("chestny_enrichment_queue")
        .select("status,candidate_snapshot").eq("run_id", cohortRun.id).order("id").range(offset, offset + 999);
      if (queueError) throw new Error(queueError.message);
      for (const item of queueRows ?? []) {
        if (!completedStatuses.includes(item.status)) continue;
        const manufacturer = String(asRecord(item.candidate_snapshot).quotaManufacturer ?? "");
        if (manufacturer) processedByManufacturer.set(manufacturer, (processedByManufacturer.get(manufacturer) ?? 0) + 1);
      }
      if (!queueRows || queueRows.length < 1_000) break;
    }
  }
  const states: BrandSearchState[] = (rows ?? []).map((row: Record<string, unknown>) => ({
    manufacturer: String(row.manufacturer), diversityWeight: Number(row.target), publishedCount: Number(row.published_count),
    searchOffset: Number(row.search_offset), scannedCount: Number(row.scanned_count), candidateCount: Number(row.candidate_count),
    processedCandidates: processedByManufacturer.get(String(row.manufacturer)) ?? 0, conversionRate: row.conversion_rate === null ? null : Number(row.conversion_rate),
    exhausted: row.status === "exhausted",
  }));
  const plan = planBrandSearch(states);
  const totalWeight = plan.reduce((sum, item) => sum + item.diversityWeight, 0);
  const printable = plan.map((item) => ({
    manufacturer: item.manufacturer, recommendedMixPercent: totalWeight ? Number((item.diversityWeight / totalWeight * 100).toFixed(1)) : 0,
    published: item.publishedCount, searchOffset: item.searchOffset, scanned: item.scannedCount,
    candidates: item.candidateCount, processed: item.processedCandidates, backlog: item.backlogCandidates,
    historicalScreeningConversion: item.conversionRate,
    status: item.exhausted ? "exhausted" : "search-to-source-exhaustion",
  }));
  if (!apply) {
    console.log(JSON.stringify({ mode: "plan_only", launchId: launch.id, launchName: launch.name, pageSize,
      volumeLimit: null, brandTargetsAreGuidanceOnly: true, brands: printable }, null, 2));
    return;
  }

  if (!plan.some((brand) => !brand.exhausted)) {
    const linkedRunIds = [...new Set((rows ?? []).map((row: Record<string, unknown>) => row.run_id)
      .filter((id: unknown): id is string => typeof id === "string"))];
    const { data: activeRuns, error: activeRunError } = linkedRunIds.length
      ? await client.from("chestny_enrichment_runs").select("id,status").in("id", linkedRunIds).in("status", ["approved", "running"])
      : { data: [], error: null };
    if (activeRunError) throw new Error(activeRunError.message);
    const resumableRunId = activeRuns?.[0]?.id ?? null;
    console.log(JSON.stringify({ mode: "no_searchable_brands", launchId: launch.id, launchName: launch.name,
      runId: resumableRunId, queued: 0, noSearchableBrands: !resumableRunId, brands: printable }, null, 2));
    return;
  }

  const transportArgument = process.argv.find((arg) => arg.startsWith("--transport="))?.slice("--transport=".length)
    ?? process.env.CHESTNY_ENCAR_TRANSPORT?.trim()
    ?? "proxy";
  if (transportArgument !== "direct" && transportArgument !== "proxy") throw new Error("Encar transport must be direct or proxy");
  // Resolve credentials before any search or run mutation. Direct mode removes
  // a possibly inherited proxy URL so encarFetch cannot silently use it.
  if (transportArgument === "proxy") process.env.ENCAR_PROXY_URL = readEncarProxyUrlFromKeychain();
  else delete process.env.ENCAR_PROXY_URL;

  const linkedRunIds = [...new Set((rows ?? []).map((row: Record<string, unknown>) => row.run_id)
    .filter((id: unknown): id is string => typeof id === "string"))];
  let runId: string | undefined;
  let previousRunId: string | undefined;
  if (linkedRunIds.length) {
    const { data: linkedRuns, error: linkedRunsError } = await client.from("chestny_enrichment_runs").select("id,status").in("id", linkedRunIds);
    if (linkedRunsError) throw new Error(linkedRunsError.message);
    runId = (linkedRuns ?? []).find((row) => ["approved", "running"].includes(row.status))?.id;
    previousRunId = linkedRunIds.find((id) => id !== runId);
  }
  if (!runId) {
    const { data: prior, error: priorError } = await client.from("chestny_enrichment_runs").select("id,status")
      .eq("source_file", "local-catalog-launch-search").contains("rules", { catalogLaunchId: launch.id }).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (priorError) throw new Error(priorError.message);
    if (prior && ["approved", "running"].includes(prior.status)) runId = prior.id;
  }
  if (!runId) {
    const { data: run, error: runError } = await client.from("chestny_enrichment_runs").insert({
      project: "chestny-prigon", status: "approved", candidate_count: 0, source_file: "local-catalog-launch-search",
      rules: { catalogLaunchId: launch.id, catalogLaunchName: launch.name, policyVersion: CATALOG_POLICY.version,
        discoveryOnly: true, transport: transportArgument, publication: publicationMode,
        publicationAuthorized: publicationMode === "auto_after_screening", searchMode: "all_eligible_until_source_exhaustion" },
    }).select("id").single();
    if (runError) throw new Error(runError.message);
    runId = run.id;
  }
  if (!runId) throw new Error("Could not resolve the candidate discovery run");
  const activeRunId = runId;
  const { data: activeRun, error: activeRunError } = await client.from("chestny_enrichment_runs").select("status,rules").eq("id", activeRunId).single();
  if (activeRunError) throw new Error(activeRunError.message);
  const savedTransport = asRecord(activeRun.rules).transport;
  if (savedTransport && savedTransport !== transportArgument) {
    throw new Error(`Run transport is ${String(savedTransport)}; refusing to search through ${transportArgument}`);
  }
  const savedPublication = asRecord(activeRun.rules).publication ?? "disabled";
  if (savedPublication !== publicationMode) {
    throw new Error(`Run publication mode is ${String(savedPublication)}; refusing to change it to ${publicationMode} after run creation`);
  }
  if (!savedTransport) {
    if (activeRun.status !== "approved") throw new Error("Cannot set transport on a run that has already started");
    const { error: transportError } = await client.from("chestny_enrichment_runs")
      .update({ rules: { ...asRecord(activeRun.rules), transport: transportArgument } }).eq("id", activeRunId).eq("status", "approved");
    if (transportError) throw new Error(`Could not persist Encar transport: ${transportError.message}`);
  }
  const { error: attachError } = await client.from("chestny_catalog_brand_search_progress")
    .update({ run_id: runId }).eq("launch_id", launch.id)
    .or(previousRunId ? `run_id.is.null,run_id.eq.${previousRunId}` : "run_id.is.null");
  if (attachError) throw new Error(attachError.message);

  await withEnrichmentWorkerLock({ db: client, runId: activeRunId, task: async (_token, signal) => {
  const summaries: Array<Record<string, unknown>> = [];
  const searchable = plan.filter((brand) => !brand.exhausted);
  try {
    await notifyCatalogOwner(`Поиск Encar запущен по ${searchable.length} маркам. Марочные доли служат ориентиром разнообразия; ищу все подходящие объявления до исчерпания выдачи, сохраняю offset после каждой страницы.`);
  } catch (error) {
    console.error(`Telegram search progress notification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  let finishedBrands = 0;
  let foundAcrossBrands = 0;
  for (const brand of plan) {
    if (signal.aborted) throw signal.reason;
    if (brand.exhausted) continue;
    const query = createDomesticQuery(CATALOG_POLICY.minYear, new Date().getFullYear(), CATALOG_POLICY.maxMileageKm,
      "Y", primaryManufacturerAlias(brand.manufacturer), null, null);
    let offset = brand.searchOffset;
    const { error: startError } = await client.rpc("start_chestny_catalog_brand_search", {
      p_launch: launch.id, p_manufacturer: brand.manufacturer, p_run: activeRunId,
    });
    if (startError) throw new Error(`${brand.manufacturer}: ${startError.message}`);
    let found = 0;
    let scanned = 0;
    let pages = 0;
    let exhausted = false;
    let filteredByInitialRules = 0;
    let alreadyKnown = 0;
    while (!exhausted) {
      let page: Awaited<ReturnType<typeof fetchDirectSearchPage>>;
      const requestStartedAt = Date.now();
      try {
        page = await fetchDirectSearchPage({ offset, limit: pageSize, query, signal, verifyAccess: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ event: "encar_search_page_failed", runId: activeRunId, manufacturer: brand.manufacturer,
          offset, limit: pageSize, httpStatus: Number(message.match(/HTTP (\d{3})/)?.[1]) || null,
          elapsedMs: Date.now() - requestStartedAt, observedAt: new Date().toISOString(), classification: /403/.test(message) ? "blocked" : /429/.test(message) ? "rate_limited" : /fetch failed|timeout|socket|econn|eai_again/i.test(message) ? "network_error" : "request_error" }));
        await client.rpc("record_chestny_catalog_search_error", { p_launch: launch.id, p_manufacturer: brand.manufacturer, p_message: message });
        throw error;
      }
      console.log(JSON.stringify({ event: "encar_search_page", runId: activeRunId, manufacturer: brand.manufacturer,
        offset, limit: pageSize, httpStatus: 200, elapsedMs: Date.now() - requestStartedAt,
        returned: page.listings.length, sourceTotal: page.total, observedAt: new Date().toISOString() }));
      let excludedByInitialRules = 0;
      const candidates = page.listings.flatMap((listing) => {
        const id = String(listing.Id ?? "").trim();
        if (!id || searchExclusionReasons(listing).length) { excludedByInitialRules += 1; return []; }
        const modelYear = toModelYear(listing.Year) ?? toModelYear(listing.FormYear);
        if (modelYear !== null && modelYear < CATALOG_POLICY.minYear) { excludedByInitialRules += 1; return []; }
        const snapshot = {
          ...listing, encarId: id, quotaManufacturer: brand.manufacturer,
          manufacturer: listing.Manufacturer ?? null, model: listing.Model ?? null, modelYear,
          mileageKm: Number(listing.Mileage) || null, priceKrw: (Number(listing.Price) || 0) * 10_000,
        };
        return [{ source_listing_id: id, source_url: `https://www.encar.com/dc/dc_cardetailview.do?carid=${encodeURIComponent(id)}`, candidate_snapshot: snapshot }];
      });
      const pageIds = [...new Set(candidates.map((candidate) => candidate.source_listing_id))];
      const knownIds = await existingIdentifiers(client, pageIds);
      alreadyKnown += candidates.filter((candidate) => knownIds.has(candidate.source_listing_id)).length;
      filteredByInitialRules += excludedByInitialRules;
      const newCandidates = candidates.filter((candidate) => !knownIds.has(candidate.source_listing_id));
      const nextOffset = offset + pageSize;
      exhausted = page.listings.length < pageSize || nextOffset >= page.total;
      const { data: inserted, error: pageError } = await client.rpc("record_chestny_catalog_search_page", {
        p_launch: launch.id, p_manufacturer: brand.manufacturer, p_run: activeRunId,
        p_expected_offset: offset, p_next_offset: nextOffset, p_scanned: page.listings.length,
        p_candidates: newCandidates, p_exhausted: exhausted,
      });
      if (pageError) {
        await client.rpc("record_chestny_catalog_search_error", { p_launch: launch.id, p_manufacturer: brand.manufacturer, p_message: pageError.message });
        throw new Error(`${brand.manufacturer} offset ${offset}: ${pageError.message}`);
      }
      const insertedCount = Number(inserted ?? 0);
      offset = nextOffset;
      found += insertedCount;
      scanned += page.listings.length;
      pages += 1;
      await new Promise((resolve) => setTimeout(resolve, CATALOG_POLICY.requestDelayMs));
    }
    summaries.push({ manufacturer: brand.manufacturer, startOffset: brand.searchOffset, nextOffset: offset, scanned, pages,
      filteredByInitialRules, alreadyKnown, newCandidates: found, exhausted, sourceTotalReached: exhausted });
    finishedBrands += 1;
    foundAcrossBrands += found;
    // Report only at stable five-brand milestones. The control task reports the
    // completed search and worker start, so a short run does not emit a
    // redundant per-brand message just before enrichment begins.
    if (finishedBrands % 5 === 0) {
      try {
        await notifyCatalogOwner(`Поиск: проверена выдача ${finishedBrands}/${searchable.length} марок; найдено новых подходящих объявлений ${foundAcrossBrands}. Последняя марка: ${brand.manufacturer}, позиция ${offset}${exhausted ? " (выдача исчерпана)" : ""}.`);
      } catch (error) {
        console.error(`Telegram search progress notification failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const { data: finalProgress, error: progressError } = await client.from("chestny_catalog_brand_search_status")
    .select("manufacturer,target,published_count,remaining_quota,search_offset,scanned_count,candidate_count,processed_candidates,candidate_backlog,conversion_rate,status,candidates_needed_at_observed_conversion")
    .eq("launch_id", launch.id).order("manufacturer");
  if (progressError) throw new Error(progressError.message);
  console.log(JSON.stringify({ mode: "search_completed", launchId: launch.id, runId: activeRunId, transport: transportArgument,
    searchMode: "all_eligible_until_source_exhaustion", volumeLimit: null, pageSize,
    brandTargetsAreGuidanceOnly: true, pages: summaries, progress: finalProgress }, null, 2));
  } });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
