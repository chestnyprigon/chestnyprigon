import { config } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetchDirectSearchPage, createDomesticQuery } from "../encar/client";
import { CATALOG_POLICY } from "../encar/catalog-policy";
import { primaryManufacturerAlias } from "../encar/manufacturer-aliases";
import { planBrandSearch, type BrandSearchState } from "./resumable-search";
import { withEnrichmentWorkerLock } from "../radar/enrichment-worker-lock";
import { notifyCatalogOwner } from "../radar/telegram-catalog-notify";

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
      client.from("chestny_enrichment_queue").select("source_listing_id").in("source_listing_id", chunk),
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
  const pageSize = numberArgument("page-size", 100, 20, 200);
  const pilotPoolTarget = numberArgument("pilot-candidates", 50, 1, 500);
  const maxPagesPerBrand = numberArgument("max-pages-per-brand", 3, 1, 20);
  const launchId = process.env.CHESTNY_CATALOG_LAUNCH_ID?.trim();
  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let launchQuery = client.from("chestny_catalog_launches").select("id,name,status,rules");
  if (launchId) launchQuery = launchQuery.eq("id", launchId);
  else launchQuery = launchQuery.eq("name", "local-catalog-1000-20261007");
  const { data: launch, error: launchError } = await launchQuery.single();
  if (launchError) throw new Error(launchError.message);
  if (!(["prepared", "running"] as string[]).includes(launch.status)) throw new Error(`Launch status is ${launch.status}`);

  const { data: rows, error } = await client.from("chestny_catalog_brand_search_status")
    .select("manufacturer,target,remaining_quota,published_count,search_offset,scanned_count,candidate_count,processed_candidates,conversion_rate,status,last_error,run_id")
    .eq("launch_id", launch.id).order("manufacturer");
  if (error) throw new Error(error.message);
  const processedByManufacturer = new Map<string, number>();
  const { data: cohortRuns, error: cohortError } = await client.from("chestny_enrichment_runs")
    .select("id").contains("rules", { catalogLaunchId: launch.id });
  if (cohortError) throw new Error(cohortError.message);
  const completedStatuses = ["succeeded", "unavailable", "failed", "cancelled"];
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
    manufacturer: String(row.manufacturer), quotaTarget: Number(row.target), remainingQuota: Number(row.remaining_quota),
    searchOffset: Number(row.search_offset), scannedCount: Number(row.scanned_count), candidateCount: Number(row.candidate_count),
    processedCandidates: processedByManufacturer.get(String(row.manufacturer)) ?? 0, conversionRate: row.conversion_rate === null ? null : Number(row.conversion_rate),
    exhausted: row.status === "exhausted",
  }));
  const plan = planBrandSearch(states, pilotPoolTarget);
  const printable = plan.map((item) => ({
    manufacturer: item.manufacturer, target: item.quotaTarget, published: item.quotaTarget - item.remainingQuota,
    remaining: item.remainingQuota, searchOffset: item.searchOffset, scanned: item.scannedCount,
    candidates: item.candidateCount, processed: item.processedCandidates, backlog: item.backlogCandidates,
    pilotConversion: item.conversionRate, candidatesToFind: item.candidatesToFind,
    conversionBlocked: item.conversionBlocked,
    reserveBasis: item.conversionRate === null ? `pilot pool (${pilotPoolTarget})` : "observed pilot conversion",
    status: item.exhausted ? "exhausted" : item.conversionBlocked ? "pilot-conversion-zero" : "searchable",
  }));
  if (!apply) {
    console.log(JSON.stringify({ mode: "plan_only", launchId: launch.id, launchName: launch.name, pageSize, maxPagesPerBrand, brands: printable }, null, 2));
    return;
  }

  if (!plan.some((brand) => brand.candidatesToFind > 0)) {
    console.log(JSON.stringify({ mode: "no_searchable_brands", launchId: launch.id, launchName: launch.name, runId: null, queued: 0, noSearchableBrands: true, brands: printable }, null, 2));
    return;
  }

  let runId = (rows ?? []).map((row: Record<string, unknown>) => row.run_id).find((id: unknown) => typeof id === "string") as string | undefined;
  let previousRunId: string | undefined;
  if (runId) {
    const { data: previousRun, error: previousRunError } = await client.from("chestny_enrichment_runs").select("id,status").eq("id", runId).single();
    if (previousRunError) throw new Error(previousRunError.message);
    if (["completed", "cancelled"].includes(previousRun.status)) {
      previousRunId = runId;
      runId = undefined;
    }
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
      rules: { catalogLaunchId: launch.id, catalogLaunchName: launch.name, policyVersion: CATALOG_POLICY.version, discoveryOnly: true },
    }).select("id").single();
    if (runError) throw new Error(runError.message);
    runId = run.id;
  }
  if (!runId) throw new Error("Could not resolve the candidate discovery run");
  const activeRunId = runId;
  const { error: attachError } = await client.from("chestny_catalog_brand_search_progress")
    .update({ run_id: runId }).eq("launch_id", launch.id)
    .or(previousRunId ? `run_id.is.null,run_id.eq.${previousRunId}` : "run_id.is.null");
  if (attachError) throw new Error(attachError.message);

  await withEnrichmentWorkerLock({ db: client, runId: activeRunId, task: async (_token, signal) => {
  const summaries: Array<Record<string, unknown>> = [];
  const searchable = plan.filter((brand) => brand.candidatesToFind > 0 && !brand.exhausted);
  try {
    await notifyCatalogOwner(`Поиск новой волны запущен: ${searchable.length} марок имеют квотный недобор. Буду сохранять offset после каждой страницы.`);
  } catch (error) {
    console.error(`Telegram search progress notification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  let finishedBrands = 0;
  let foundAcrossBrands = 0;
  for (const brand of plan) {
    if (signal.aborted) throw signal.reason;
    if (!brand.candidatesToFind || brand.exhausted) continue;
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
    while (found < brand.candidatesToFind && !exhausted && pages < maxPagesPerBrand) {
      let page: Awaited<ReturnType<typeof fetchDirectSearchPage>>;
      try {
        page = await fetchDirectSearchPage({ offset, limit: pageSize, query, signal });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await client.rpc("record_chestny_catalog_search_error", { p_launch: launch.id, p_manufacturer: brand.manufacturer, p_message: message });
        throw error;
      }
      const candidates = page.listings.flatMap((listing) => {
        const id = String(listing.Id ?? "").trim();
        if (!id) return [];
        const modelYear = toModelYear(listing.Year) ?? toModelYear(listing.FormYear);
        if (modelYear !== null && modelYear < CATALOG_POLICY.minYear) return [];
        const snapshot = {
          ...listing, encarId: id, quotaManufacturer: brand.manufacturer,
          manufacturer: listing.Manufacturer ?? null, model: listing.Model ?? null, modelYear,
          mileageKm: Number(listing.Mileage) || null, priceKrw: (Number(listing.Price) || 0) * 10_000,
        };
        return [{ source_listing_id: id, source_url: `https://www.encar.com/dc/dc_cardetailview.do?carid=${encodeURIComponent(id)}`, candidate_snapshot: snapshot }];
      });
      const pageIds = [...new Set(candidates.map((candidate) => candidate.source_listing_id))];
      const knownIds = await existingIdentifiers(client, pageIds);
      const allowance = Math.max(0, brand.candidatesToFind - found);
      const newCandidates = candidates.filter((candidate) => !knownIds.has(candidate.source_listing_id)).slice(0, allowance);
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
    summaries.push({ manufacturer: brand.manufacturer, startOffset: brand.searchOffset, nextOffset: offset, scanned, pages, newCandidates: found, exhausted, targetReached: found >= brand.candidatesToFind });
    finishedBrands += 1;
    foundAcrossBrands += found;
    if (finishedBrands % 5 === 0 || finishedBrands === searchable.length) {
      try {
        await notifyCatalogOwner(`Поиск квот: обработано марок ${finishedBrands}/${searchable.length}; найдено новых кандидатов ${foundAcrossBrands}. Последняя: ${brand.manufacturer}, offset ${offset}${exhausted ? " (выдача исчерпана)" : ""}.`);
      } catch (error) {
        console.error(`Telegram search progress notification failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const { data: finalProgress, error: progressError } = await client.from("chestny_catalog_brand_search_status")
    .select("manufacturer,target,published_count,remaining_quota,search_offset,scanned_count,candidate_count,processed_candidates,candidate_backlog,conversion_rate,status,candidates_needed_at_observed_conversion")
    .eq("launch_id", launch.id).order("manufacturer");
  if (progressError) throw new Error(progressError.message);
  console.log(JSON.stringify({ mode: "search_completed", launchId: launch.id, runId: activeRunId, pageSize, maxPagesPerBrand, pages: summaries, progress: finalProgress }, null, 2));
  } });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
