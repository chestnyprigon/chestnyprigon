import { searchExclusionReasons } from "../encar/screening";
import type { EncarSearchListing } from "../encar/types";
import { CATALOG_POLICY } from "../encar/catalog-policy";
import { readFile } from "node:fs/promises";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { encarHeaders } from "../encar/auth";
import { CATALOG_WAVES, selectWaveBatches } from "../encar/waves";
import { primaryManufacturerAlias } from "../encar/manufacturer-aliases";
import { readEncarProxyUrlFromKeychain } from "../encar/proxy";

const direct = process.argv.includes("--direct");
const localKeychainProxy = process.argv.includes("--local-keychain-proxy");
if (direct && localKeychainProxy) throw new Error("Choose either --direct or --local-keychain-proxy");
if (direct || localKeychainProxy) config({ path: ".env.local", quiet: true });
else config({ path: ".env", quiet: true });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function argument(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1];
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

const proxyUrl = direct ? null : localKeychainProxy ? readEncarProxyUrlFromKeychain() : required("ENCAR_PROXY_URL");
if (proxyUrl) process.env.ENCAR_PROXY_URL = proxyUrl;
const targetCandidates = argument("target", 3_200, 100, 5_000);
const pageSize = argument("page-size", 500, 50, 500);
const overscanRaw = process.argv.find((value) => value.startsWith("--overscan="))?.split("=")[1];
const overscan = overscanRaw === undefined ? 2.5 : Number(overscanRaw);
if (!Number.isFinite(overscan) || overscan < 1 || overscan > 4) throw new Error("--overscan must be a number from 1 to 4");
const searchBudget = Math.min(20_000, Math.ceil(targetCandidates * overscan));
const pageOffset = argument("page-offset", 0, 0, 100_000);
const maxMileage = argument("max-mileage", 190_000, 1, 500_000);
const yearFrom = argument("year-from", 2016, 1990, new Date().getFullYear());
const yearTo = new Date().getFullYear();
const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function modelYear(listing: Record<string, unknown>) {
  const encoded = number(listing.Year);
  if (encoded !== null && encoded >= 190000) return Math.floor(encoded / 100);
  return number(listing.FormYear) ?? null;
}


async function search(agent: ProxyAgent | null, query: string, offset: number, limit: number) {
  const url = new URL("https://api.encar.com/search/car/list/general");
  url.searchParams.set("count", "true");
  url.searchParams.set("q", query);
  url.searchParams.set("sr", `|ModifiedDate|${offset}|${limit}`);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(url, {
        headers: encarHeaders({
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
          Origin: "https://www.encar.com",
          Referer: "https://www.encar.com/",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
        }),
        ...(agent ? { dispatcher: agent } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (attempt === 3) throw new Error(`Encar search network request failed after ${attempt} attempts (${error instanceof Error ? error.name : "unknown error"})`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 3_000));
      continue;
    }
    if (response.status === 403) throw new Error("Encar search HTTP 403 access restriction; discovery stopped without saving candidates");
    if (response.status === 429) throw new Error("Encar search HTTP 429 rate limit; discovery stopped without saving candidates");
    if (response.status >= 500 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 3_000));
      continue;
    }
    if (!response.ok) throw new Error(`Encar search HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) throw new Error(`Encar search returned non-JSON content (${contentType || "unknown content type"})`);
    const payload = await response.json() as { Count?: number; SearchResults?: Array<Record<string, unknown>>; iNav?: unknown };
    if (!Array.isArray(payload.SearchResults)) {
      if (payload.iNav !== undefined) throw new Error("Encar returned navigation metadata without SearchResults; refusing to treat it as an empty result");
      throw new Error("Encar search JSON does not contain SearchResults");
    }
    const total = Number(payload.Count ?? 0);
    if (payload.SearchResults.length === 0 && offset < total) {
      throw new Error(`Encar returned an empty page before the reported end of results (offset=${offset}, total=${total})`);
    }
    return { total, listings: payload.SearchResults };
  }
  throw new Error("Encar search request exhausted its retry policy");
}

function createSearchQuery(manufacturer: string | undefined, fromYear: number, toYear: number, mileage: number, carType: "Y" | "A") {
  const inventoryQuery = manufacturer
    ? `(And.Hidden.N._.(C.CarType.${carType}._.Manufacturer.${manufacturer}.))`
    : `(And.Hidden.N._.CarType.${carType}.)`;
  const advertisedQuery = `(And.${inventoryQuery}_.AdType.A.)`;
  return `(And.${advertisedQuery}_.Year.range(${fromYear}00..${toYear}99)._.Mileage.range(..${mileage}).)`;
}

async function existingIdentifiers(ids: string[]) {
  const existing = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    const queries = await Promise.all([
      db.from("vehicles").select("source_listing_id").in("source_listing_id", chunk),
      db.from("encar_raw_listings").select("source_listing_id").in("source_listing_id", chunk),
      db.from("chestny_catalog_staging").select("source_listing_id").in("source_listing_id", chunk),
      db.from("vehicle_source_identifiers").select("source_identifier").in("source_identifier", chunk),
      db.from("chestny_discovery_reserved_queue").select("source_listing_id").in("source_listing_id", chunk),
      db.from("chestny_enrichment_queue").select("source_listing_id").in("source_listing_id", chunk),
      db.from("chestny_catalog_launch_baseline_identifiers").select("source_identifier").in("source_identifier", chunk),
    ]);
    for (const result of queries) {
      if (result.error) throw new Error(result.error.message);
      for (const row of result.data ?? []) {
        const value = (row as { source_listing_id?: unknown; source_identifier?: unknown }).source_listing_id
          ?? (row as { source_identifier?: unknown }).source_identifier;
        if (value !== undefined && value !== null) existing.add(String(value));
      }
    }
  }
  return existing;
}

async function verifyDiscoveryStorage() {
  const checks = await Promise.all([
    db.from("vehicles").select("source_listing_id").limit(0),
    db.from("encar_raw_listings").select("source_listing_id").limit(0),
    db.from("chestny_catalog_staging").select("source_listing_id").limit(0),
    db.from("vehicle_source_identifiers").select("source_identifier").limit(0),
    db.from("chestny_discovery_reserved_queue").select("source_listing_id").limit(0),
    db.from("chestny_enrichment_queue").select("run_id,source_listing_id,source_url,candidate_snapshot,status").limit(0),
    db.from("chestny_catalog_launch_baseline_identifiers").select("source_identifier").limit(0),
    db.from("chestny_enrichment_runs").select("id,status,candidate_count,source_file,rules").limit(0),
  ]);
  const failed = checks.find((result) => result.error);
  if (failed?.error) throw new Error(`Discovery storage preflight failed before Encar requests: ${failed.error.message}`);
}

async function main() {
  const quotasFile = process.argv.find((arg) => arg.startsWith("--brand-quotas="))?.slice("--brand-quotas=".length);
  const brandQuotas: Array<{ manufacturer: string; candidates: number; publicationTarget?: number }> = quotasFile
    ? JSON.parse(await readFile(quotasFile, "utf8")) : [];
  if (quotasFile && (!Array.isArray(brandQuotas) || !brandQuotas.length
    || new Set(brandQuotas.map((q) => q.manufacturer)).size !== brandQuotas.length
    || brandQuotas.some((q) => !q.manufacturer || q.manufacturer === "*" || !Number.isInteger(q.candidates) || q.candidates < 1)
    || brandQuotas.reduce((sum, q) => sum + q.candidates, 0) !== targetCandidates)) {
    throw new Error("Brand quotas must have unique manufacturers and candidate counts summing to --target");
  }
  if ((direct || localKeychainProxy) && process.env.CHESTNY_CATALOG_LAUNCH_ID?.trim()) throw new Error("Standalone local discovery must not inherit a separate catalog launch");
  if ((direct || localKeychainProxy) && new URL(required("NEXT_PUBLIC_SUPABASE_URL")).hostname !== "ojnybjomttolhsfgkdqq.supabase.co") throw new Error("Unexpected Supabase project for Chestny Prigon");
  const agent = proxyUrl ? new ProxyAgent(proxyUrl) : null;
  if (localKeychainProxy && !agent) throw new Error("Local Keychain mode requires a configured Decodo proxy");
  if (process.argv.includes("--probe-all")) {
    try {
      const results = [];
      for (const carType of ["Y", "A"] as const) {
        const page = await search(agent, createSearchQuery(undefined, yearFrom, yearTo, maxMileage, carType), 0, pageSize);
        const manufacturers = [...new Set(page.listings.map((item) => String(item.Manufacturer ?? "")).filter(Boolean))].sort();
        results.push({ carType, returned: page.listings.length, total: page.total, manufacturers });
      }
      console.log(JSON.stringify({ status: "ok", mode: "probe_all", transport: localKeychainProxy ? "decodo_proxy" : direct ? "direct" : "proxy", results, databaseWrites: false, enrichmentStarted: false, publicationAttempted: false }, null, 2));
    } finally {
      await agent?.close();
    }
    return;
  }
  if (process.argv.includes("--probe-only")) {
    const manufacturerName = brandQuotas[0]?.manufacturer;
    if (!manufacturerName) throw new Error("--probe-only requires --brand-quotas");
    try {
      const manufacturer = process.argv.find((arg) => arg.startsWith("--probe-alias="))?.slice("--probe-alias=".length)
        ?? primaryManufacturerAlias(manufacturerName);
      const probeCarType = process.argv.includes("--probe-car-type=Y") ? "Y" : "A";
      const query = createSearchQuery(manufacturer, yearFrom, yearTo, maxMileage, probeCarType);
      const page = await search(agent, query, pageOffset, pageSize);
      console.log(JSON.stringify({ status: "ok", mode: "probe_only", transport: localKeychainProxy ? "decodo_proxy" : direct ? "direct" : "proxy", manufacturer: manufacturerName, manufacturerAlias: manufacturer, carType: probeCarType, returned: page.listings.length, total: page.total, databaseWrites: false, enrichmentStarted: false, publicationAttempted: false }, null, 2));
    } finally {
      await agent?.close();
    }
    return;
  }
  await verifyDiscoveryStorage();
  const runId = crypto.randomUUID();
  const selected = new Map<string, Record<string, unknown>>();
  const newCandidates = new Map<string, Record<string, unknown>>();
  const known = new Set<string>();
  const knownByBrand = new Map<string, number>();
  const excludedByBrand = new Map<string, Map<string, number>>();
  const candidateManufacturer = new Map<string, string>();
  const quotaByBrand = new Map(brandQuotas.map((q) => [q.manufacturer, q.candidates]));
  const candidatesByBrand = new Map<string, number>();
  const batches = brandQuotas.length ? (() => {
    const planned: Array<{ wave: { id: string; manufacturer: string }; offset: number; limit: number }> = [];
    const budgets = brandQuotas.map((q) => ({ ...q, budget: Math.ceil(q.candidates * overscan) }));
    for (let offset = 0; budgets.some((q) => offset < q.budget); offset += pageSize) {
      for (const q of budgets) if (offset < q.budget) planned.push({ wave: { id: `local-${q.manufacturer}`, manufacturer: q.manufacturer }, offset, limit: Math.min(pageSize, q.budget - offset) });
    }
    return planned;
  })() : selectWaveBatches(searchBudget, ["european", "korean", "other"]);
  const details: Array<Record<string, unknown>> = [];
  try {
    for (const batch of batches) {
      const wave = brandQuotas.length ? batch.wave : [...CATALOG_WAVES].find((item) => item.id === batch.wave.id);
      if (!wave) continue;
      if (quotaByBrand.has(wave.manufacturer) && (candidatesByBrand.get(wave.manufacturer) ?? 0) >= quotaByBrand.get(wave.manufacturer)!) continue;
      const manufacturer = wave.manufacturer === "*" ? undefined : primaryManufacturerAlias(wave.manufacturer);
      // CarType.A is Encar's broad vehicle set and includes both domestic and imported makes.
      const query = createSearchQuery(manufacturer, yearFrom, yearTo, maxMileage, "A");
      const page = await search(agent, query, pageOffset + batch.offset, Math.min(pageSize, batch.limit));
      const pageIds: string[] = [];
      for (const listing of page.listings) {
        const id = String(listing.Id ?? "");
        if (!id || selected.has(id)) continue;
        const reasons = searchExclusionReasons(listing as EncarSearchListing);
        if (reasons.length > 0) {
          const counts = excludedByBrand.get(wave.manufacturer) ?? new Map<string, number>();
          for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
          excludedByBrand.set(wave.manufacturer, counts);
          continue;
        }
        const year = modelYear(listing);
        if (year !== null && year < yearFrom) {
          const counts = excludedByBrand.get(wave.manufacturer) ?? new Map<string, number>();
          counts.set("model_year_below_minimum", (counts.get("model_year_below_minimum") ?? 0) + 1);
          excludedByBrand.set(wave.manufacturer, counts);
          continue;
        }
        selected.set(id, listing);
        pageIds.push(id);
      }
      const knownPage = await existingIdentifiers(pageIds);
      for (const id of knownPage) known.add(id);
      knownByBrand.set(wave.manufacturer, (knownByBrand.get(wave.manufacturer) ?? 0) + knownPage.size);
      for (const id of pageIds) {
        const listing = selected.get(id);
        if (listing && !knownPage.has(id)
          && (candidatesByBrand.get(wave.manufacturer) ?? 0) < (quotaByBrand.get(wave.manufacturer) ?? targetCandidates)) {
          newCandidates.set(id, listing);
          candidateManufacturer.set(id, wave.manufacturer);
          candidatesByBrand.set(wave.manufacturer, (candidatesByBrand.get(wave.manufacturer) ?? 0) + 1);
        }
      }
      details.push({ wave: batch.wave.id, manufacturer: wave.manufacturer, offset: batch.offset, requested: batch.limit, returned: page.listings.length, total: page.total, selected: selected.size, newCandidates: newCandidates.size, brandCandidates: candidatesByBrand.get(wave.manufacturer) ?? 0 });
      console.error(JSON.stringify({ phase: "candidate_search", ...details[details.length - 1] }));
      // Keep candidate discovery itself gentle and serialized.
      await new Promise((resolve) => setTimeout(resolve, CATALOG_POLICY.requestDelayMs));
      if (newCandidates.size >= targetCandidates || selected.size >= searchBudget) break;
    }
  } finally {
    await agent?.close();
  }
  const candidates = [...newCandidates.keys()].slice(0, targetCandidates);
  if (!candidates.length) throw new Error("No new live Encar candidates were found");
  const { error: runError } = await db.from("chestny_enrichment_runs").insert({
    id: runId,
    project: "chestny-prigon",
    status: "awaiting_approval",
    candidate_count: candidates.length,
    source_file: direct ? "local-live-encar-search-direct" : localKeychainProxy ? "local-live-encar-search-decodo" : "vps-live-encar-search",
    rules: { yearFrom, yearTo, maxMileage, targetCandidates, publicationTarget: brandQuotas.reduce((sum, quota) => sum + Number(quota.publicationTarget ?? 0), 0), searchBudget, overscan, pageSize, pageOffset, brandQuotas, groups: ["european", "korean", "other"], publication: "manual-after-screening-and-price-audit", rulesVersion: CATALOG_POLICY.version, catalogLaunchId: null, transport: direct ? "direct" : localKeychainProxy ? "decodo_proxy" : "proxy", stage: "search_dedupe_search-field-prefilter_only" },
  });
  if (runError) throw new Error(runError.message);
  try {
    for (let offset = 0; offset < candidates.length; offset += 500) {
      const rows = candidates.slice(offset, offset + 500).map((id) => ({
        run_id: runId,
        source_listing_id: id,
        source_url: `https://www.encar.com/dc/dc_cardetailview.do?carid=${id}`,
        candidate_snapshot: (() => {
          const listing = selected.get(id) ?? { Id: id };
          return {
            ...listing,
            encarId: id,
            quotaManufacturer: candidateManufacturer.get(id) ?? null,
            manufacturer: listing.Manufacturer ?? null,
            model: listing.Model ?? null,
            modelYear: modelYear(listing),
            mileageKm: number(listing.Mileage) ?? null,
            priceKrw: (number(listing.Price) ?? 0) * 10_000,
          };
        })(),
        status: "queued",
      }));
      const { error } = await db.from("chestny_enrichment_queue").insert(rows);
      if (error) throw new Error(error.message);
    }
  } catch (error) {
    await db.from("chestny_enrichment_queue").delete().eq("run_id", runId).eq("status", "queued");
    await db.from("chestny_enrichment_runs").update({ status: "cancelled", completed_at: new Date().toISOString(), pause_reason: { source: "candidate_search_persistence", message: "Queue persistence failed; partial queued rows were removed", observedAt: new Date().toISOString() } }).eq("id", runId);
    throw error;
  }
  console.log(JSON.stringify({ status: "awaiting_approval", runId, transport: direct ? "direct" : localKeychainProxy ? "decodo_proxy" : "proxy", discovered: selected.size, knownSkipped: known.size, knownSkippedByBrand: Object.fromEntries(knownByBrand), excludedByBrand: Object.fromEntries([...excludedByBrand].map(([brand, counts]) => [brand, Object.fromEntries(counts)])), queued: candidates.length, targetCandidates, searchBudget, overscan, pageOffset, yearFrom, yearTo, maxMileage, brandQuotas, candidatesByBrand: Object.fromEntries(candidatesByBrand), batches: details, enrichmentStarted: false, publicationAttempted: false, nextStep: "review_discovery_and_explicitly_approve_enrichment" }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
