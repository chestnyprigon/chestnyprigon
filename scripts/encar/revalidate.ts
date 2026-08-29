import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { createDomesticQuery, delay, fetchSearchPage } from "./client";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const PAGE_SIZE = 500;
const SEARCH_DELAY_MS = 350;
const MAX_SEARCH_OFFSET = 200_000;
const REVALIDATION_YEAR_FROM = 1980;
const REVALIDATION_MAX_MILEAGE_KM = 1_000_000;
const REVALIDATION_PRICE_MIN = 0;
const REVALIDATION_PRICE_MAX = 100_000;
const manufacturerAliases: Record<string, string[]> = {
  Hyundai: ["현대"],
  Kia: ["기아"],
  Genesis: ["제네시스"],
  "Mercedes-Benz": ["벤츠"],
  Audi: ["아우디"],
  Volkswagen: ["폭스바겐"],
  Porsche: ["포르쉐"],
  Volvo: ["볼보"],
  "Land Rover": ["랜드로버"],
  Chevrolet: ["쉐보레", "한국GM", "GM대우"],
  Citroën: ["시트로엥", "Citroen"],
  Jeep: ["지프"],
  KGM: ["쌍용", "KG모빌리티", "KGM"],
  MINI: ["미니"],
  "Renault Korea": ["르노코리아", "르노삼성", "르노"],
  Toyota: ["토요타", "도요타"],
};

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function supabase() {
  return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function main() {
  const client = supabase();
  const now = new Date();
  const vehicles: Array<{ id: string; source_listing_id: string; source_url: string | null; manufacturer: string }> = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await client
      .from("vehicles")
      .select("id,source_listing_id,source_url,manufacturer")
      .eq("status", "active")
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    vehicles.push(...(data ?? []));
    if ((data?.length ?? 0) < 1_000) break;
  }

  const byManufacturer = new Map<string, Map<string, string>>();
  for (const vehicle of vehicles) {
    const ids = byManufacturer.get(vehicle.manufacturer) ?? new Map<string, string>();
    ids.set(vehicle.source_listing_id, vehicle.source_listing_id);
    const advertisedId = vehicle.source_url?.match(/[?&]carid=(\d+)/)?.[1];
    if (advertisedId) ids.set(advertisedId, vehicle.source_listing_id);
    byManufacturer.set(vehicle.manufacturer, ids);
  }

  const found = new Set<string>();
  const summary: Array<{ manufacturer: string; expected: number; found: number; pages: number; total: number }> = [];
  const requestedManufacturers = process.argv.find((argument) => argument.startsWith("--manufacturers="))
    ?.slice("--manufacturers=".length)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const manufacturers = [...byManufacturer.entries()]
    .filter(([manufacturer]) => !requestedManufacturers || requestedManufacturers.includes(manufacturer))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [manufacturer, expectedIds] of manufacturers) {
    const expectedCount = new Set(expectedIds.values()).size;
    let manufacturerFound = 0;
    let pages = 0;
    let total = 0;
    const aliases = manufacturerAliases[manufacturer] ?? [manufacturer];
    for (const queryManufacturer of aliases) {
      if (manufacturerFound >= expectedCount) break;
      const query = createDomesticQuery(
        REVALIDATION_YEAR_FROM,
        now.getFullYear(),
        REVALIDATION_MAX_MILEAGE_KM,
        "Y",
        queryManufacturer,
        REVALIDATION_PRICE_MIN,
        REVALIDATION_PRICE_MAX,
      );
      for (let offset = 0; offset < MAX_SEARCH_OFFSET && manufacturerFound < expectedCount; offset += PAGE_SIZE) {
        const page = await fetchSearchPage({ offset, limit: PAGE_SIZE, query });
        pages += 1;
        total = Math.max(total, page.total);
        for (const listing of page.listings) {
          const id = String(listing.Id ?? "");
          const canonicalId = expectedIds.get(id);
          if (canonicalId && !found.has(canonicalId)) {
            found.add(canonicalId);
            manufacturerFound += 1;
          }
        }
        if (!page.listings.length || offset + PAGE_SIZE >= page.total) break;
        await delay(SEARCH_DELAY_MS);
      }
    }
    summary.push({ manufacturer, expected: expectedCount, found: manufacturerFound, pages, total });
    console.log(summary.at(-1));
  }

  const missing = vehicles.filter((vehicle) => !found.has(vehicle.source_listing_id));
  const run = await client
    .from("import_runs")
    .insert({
      mode: "refresh",
      status: "running",
      cursor: {
        source: "encar-revalidation",
        checkedAt: now.toISOString(),
        strategy: "current-search-by-manufacturer",
        missingSourceListingIds: missing.map((vehicle) => vehicle.source_listing_id),
      },
    })
    .select("id")
    .single();
  if (run.error) throw new Error(run.error.message);

  const checkedAt = now.toISOString();
  const foundIds = vehicles.filter((vehicle) => found.has(vehicle.source_listing_id)).map((vehicle) => vehicle.source_listing_id);
  const missingIds = missing.map((vehicle) => vehicle.source_listing_id);
  const { data: revalidationResult, error: revalidationError } = await client.rpc("apply_catalog_revalidation", {
    p_found_source_listing_ids: foundIds,
    p_missing_source_listing_ids: missingIds,
    p_checked_at: checkedAt,
    p_archive_after: 3,
  });
  if (revalidationError) throw new Error(revalidationError.message);
  for (let offset = 0; offset < foundIds.length; offset += 500) {
    const { error: rawError } = await client
      .from("encar_raw_listings")
      .update({ last_seen_at: checkedAt })
      .in("source_listing_id", foundIds.slice(offset, offset + 500));
    if (rawError) throw new Error(rawError.message);
  }

  const { error: finishError } = await client
    .from("import_runs")
    .update({
      status: "completed",
      finished_at: new Date().toISOString(),
      fetched_count: found.size,
      accepted_count: found.size,
      rejected_count: missing.length,
      error_count: 0,
      cursor: {
        source: "encar-revalidation",
        checkedAt: now.toISOString(),
        strategy: "current-search-by-manufacturer",
        missingSourceListingIds: missing.map((vehicle) => vehicle.source_listing_id),
        revalidationResult,
        summary,
      },
    })
    .eq("id", run.data.id);
  if (finishError) throw new Error(finishError.message);

  console.log({
    status: "completed",
    catalogVehicles: vehicles.length,
    found: found.size,
    missingOnFirstPass: missing.length,
    updatedLastSeenAt: found.size,
    revalidationResult,
    note: "A second consecutive miss removes a vehicle from publication; a third archives it. Rows and photos are never deleted.",
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
