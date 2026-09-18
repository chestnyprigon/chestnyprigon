import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { createDomesticQuery } from "../encar/client";
import { CATALOG_WAVES, selectWaveBatches } from "../encar/waves";
import { primaryManufacturerAlias } from "../encar/manufacturer-aliases";

config({ path: ".env", quiet: true });

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

const proxyUrl = required("ENCAR_PROXY_URL");
const targetCandidates = argument("target", 3_200, 100, 5_000);
const pageSize = argument("page-size", 500, 50, 500);
const maxMileage = argument("max-mileage", 190_000, 1, 500_000);
const yearFrom = argument("year-from", 2016, 1990, new Date().getFullYear());
const yearTo = new Date().getFullYear();
const db = createClient<any>(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function modelYear(listing: Record<string, unknown>) {
  const encoded = number(listing.Year);
  if (encoded !== null && encoded >= 190000) return Math.floor(encoded / 100);
  return number(listing.FormYear) ?? null;
}

function obviousExclusion(listing: Record<string, unknown>) {
  const haystack = Object.values(listing).filter((value) => typeof value === "string").join(" ").toLowerCase();
  return /렌트|렌터|리스|택시|화물|영업용|대여|법인/u.test(haystack);
}

async function search(agent: ProxyAgent, query: string, offset: number, limit: number) {
  const url = new URL("https://api.encar.com/search/car/list/general");
  url.searchParams.set("count", "true");
  url.searchParams.set("q", query);
  url.searchParams.set("sr", `|ModifiedDate|${offset}|${limit}`);
  const response = await undiciFetch(url, {
    headers: { Accept: "application/json, text/plain, */*", Origin: "https://fem.encar.com", Referer: "https://fem.encar.com/" },
    dispatcher: agent,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Encar search HTTP ${response.status}`);
  const payload = await response.json() as { Count?: number; SearchResults?: Array<Record<string, unknown>> };
  if (!Array.isArray(payload.SearchResults)) throw new Error("Encar search response does not contain SearchResults");
  return { total: Number(payload.Count ?? 0), listings: payload.SearchResults };
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

async function main() {
  const agent = new ProxyAgent(proxyUrl);
  const runId = crypto.randomUUID();
  const selected = new Map<string, Record<string, unknown>>();
  const batches = selectWaveBatches(targetCandidates, ["european", "korean", "other"]);
  const details: Array<Record<string, unknown>> = [];
  try {
    for (const batch of batches) {
      const wave = [...CATALOG_WAVES].find((item) => item.id === batch.wave.id);
      if (!wave) continue;
      const manufacturer = wave.manufacturer === "*" ? undefined : primaryManufacturerAlias(wave.manufacturer);
      const query = createDomesticQuery(wave.yearFrom ?? yearFrom, yearTo, maxMileage, "Y", manufacturer);
      const page = await search(agent, query, batch.offset, Math.min(pageSize, batch.limit));
      for (const listing of page.listings) {
        const id = String(listing.Id ?? "");
        if (!id || selected.has(id) || obviousExclusion(listing)) continue;
        const year = modelYear(listing);
        if (year !== null && year < yearFrom) continue;
        selected.set(id, listing);
      }
      details.push({ wave: batch.wave.id, manufacturer: wave.manufacturer, offset: batch.offset, requested: batch.limit, returned: page.listings.length, total: page.total, selected: selected.size });
      // Keep candidate discovery itself gentle and serialized.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      if (selected.size >= targetCandidates) break;
    }
  } finally {
    await agent.close();
  }
  const ids = [...selected.keys()];
  const known = await existingIdentifiers(ids);
  const candidates = ids.filter((id) => !known.has(id)).slice(0, targetCandidates);
  if (!candidates.length) throw new Error("No new live Encar candidates were found");
  const { error: runError } = await db.from("chestny_enrichment_runs").insert({
    id: runId,
    project: "chestny-prigon",
    status: "approved",
    candidate_count: candidates.length,
    source_file: "vps-live-encar-search",
    rules: { yearFrom, yearTo, maxMileage, targetCandidates, pageSize, groups: ["european", "korean", "other"], publication: "manual-after-screening" },
  });
  if (runError) throw new Error(runError.message);
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
  console.log(JSON.stringify({ status: "approved", runId, discovered: selected.size, knownSkipped: known.size, queued: candidates.length, yearFrom, yearTo, maxMileage, batches: details }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
