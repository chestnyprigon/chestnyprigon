import path from "node:path";
import { createHash } from "node:crypto";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { createDomesticQuery, delay } from "./client";
import { MANUFACTURER_ALIASES } from "./manufacturer-aliases";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

type ModelTarget = { name: string; terms: string[]; target: number };
type BrandTarget = { brand: string; manufacturer: string; models: ModelTarget[] };

const TARGETS: BrandTarget[] = [
  { brand: "Mercedes-Benz", manufacturer: "벤츠", models: [
    { name: "GLB", terms: ["GLB"], target: 250 }, { name: "C-Class", terms: ["C-클래스", "C클래스"], target: 250 }, { name: "A-Class", terms: ["A-클래스", "A클래스"], target: 250 },
  ] },
  { brand: "Volkswagen", manufacturer: "폭스바겐", models: [
    { name: "Jetta", terms: ["제타"], target: 200 }, { name: "Tiguan", terms: ["티구안"], target: 200 }, { name: "Golf", terms: ["골프"], target: 200 },
  ] },
  { brand: "Audi", manufacturer: "아우디", models: [
    { name: "Q2", terms: ["Q2"], target: 150 }, { name: "Q3", terms: ["Q3"], target: 150 }, { name: "A4", terms: ["A4"], target: 150 }, { name: "A3", terms: ["A3"], target: 150 },
  ] },
  { brand: "BMW", manufacturer: "BMW", models: [
    { name: "X1", terms: ["X1"], target: 150 }, { name: "X2", terms: ["X2"], target: 150 }, { name: "1 Series", terms: ["1시리즈", "1-시리즈"], target: 150 }, { name: "2 Series", terms: ["2시리즈", "2-시리즈"], target: 150 },
  ] },
  { brand: "Kia", manufacturer: "기아", models: [
    { name: "Seltos", terms: ["셀토스"], target: 200 }, { name: "K5", terms: ["K5"], target: 200 }, { name: "K3", terms: ["K3"], target: 200 }, { name: "Niro", terms: ["니로"], target: 200 }, { name: "Sportage", terms: ["스포티지"], target: 200 }, { name: "Morning", terms: ["모닝"], target: 200 }, { name: "Ray", terms: ["레이"], target: 200 },
  ] },
  { brand: "MINI", manufacturer: "미니", models: [
    { name: "Cooper", terms: ["쿠퍼"], target: 125 }, { name: "Convertible", terms: ["컨버터블"], target: 125 }, { name: "Clubman", terms: ["클럽맨"], target: 125 }, { name: "Countryman", terms: ["컨트리맨"], target: 125 },
  ] },
  { brand: "Land Rover", manufacturer: "랜드로버", models: [
    { name: "Discovery", terms: ["디스커버리"], target: 150 }, { name: "Discovery Sport", terms: ["디스커버리 스포츠"], target: 150 }, { name: "Evoque", terms: ["이보크"], target: 150 },
  ] },
  { brand: "Hyundai", manufacturer: "현대", models: [
    { name: "Avante", terms: ["아반떼"], target: 150 }, { name: "Sonata", terms: ["쏘나타", "소나타"], target: 150 }, { name: "Venue", terms: ["베뉴"], target: 150 }, { name: "Casper", terms: ["캐스퍼"], target: 150 }, { name: "Veloster", terms: ["벨로스터"], target: 150 }, { name: "Tucson", terms: ["투싼"], target: 150 }, { name: "Kona", terms: ["코나"], target: 150 },
  ] },
  { brand: "Chevrolet", manufacturer: "쉐보레", models: [
    { name: "Trailblazer", terms: ["트레일블레이저"], target: 50 }, { name: "Malibu", terms: ["말리부"], target: 50 }, { name: "Equinox", terms: ["이쿼녹스"], target: 50 }, { name: "Trax", terms: ["트랙스"], target: 50 }, { name: "Spark", terms: ["스파크"], target: 50 },
  ] },
  { brand: "KGM", manufacturer: "쌍용", models: [
    { name: "Korando", terms: ["코란도"], target: 100 }, { name: "Tivoli", terms: ["티볼리"], target: 100 },
  ] },
  { brand: "Renault Korea", manufacturer: "르노", models: [
    { name: "SM6", terms: ["SM6"], target: 75 }, { name: "QM6", terms: ["QM6"], target: 75 }, { name: "XM3", terms: ["XM3"], target: 75 }, { name: "Captur", terms: ["캡처", "클리오"], target: 75 },
  ] },
];

const SEARCH_URL = "https://api.encar.com/search/car/list/general";
const PAGE_SIZE = 100;
const MAX_PAGES_PER_ALIAS = 100;
const DELAY_MS = 800;
const YEAR_FROM = 2016;
const YEAR_TO = new Date().getFullYear();
const MAX_MILEAGE = 300_000;

function argument(name: string) {
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function matches(listing: Record<string, unknown>, terms: string[]) {
  const text = `${String(listing.Model ?? "")} ${String(listing.Badge ?? "")}`.toLowerCase();
  return terms.some((term) => text.includes(term.toLowerCase()));
}

async function search(manufacturer: string, offset: number) {
  const query = createDomesticQuery(YEAR_FROM, YEAR_TO, MAX_MILEAGE, "Y", manufacturer, 300, 50_000);
  const url = new URL(SEARCH_URL);
  url.searchParams.set("count", "true");
  url.searchParams.set("q", query);
  url.searchParams.set("sr", `|ModifiedDate|${offset}|${PAGE_SIZE}`);
  const response = await fetch(url, { headers: { Accept: "application/json", Origin: "https://fem.encar.com", Referer: "https://fem.encar.com/" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Encar returned HTTP ${response.status}`);
  const payload = await response.json() as { Count?: number; SearchResults?: Record<string, unknown>[] };
  return { total: Number(payload.Count ?? 0), listings: Array.isArray(payload.SearchResults) ? payload.SearchResults : [] };
}

async function main() {
  if (process.env.ENCAR_PROXY_URL?.trim()) throw new Error("Local-only rule violated: ENCAR_PROXY_URL is set");
  const target = Number(argument("--target") ?? 5_000);
  if (!Number.isInteger(target) || target < 1 || target > 5_000) throw new Error("--target must be 1..5000");
  const requestedBrands = argument("--brands")?.split(",").map((value) => value.trim()).filter(Boolean);
  const brands = requestedBrands?.length ? TARGETS.filter((brand) => requestedBrands.includes(brand.brand)) : TARGETS;
  if (requestedBrands?.length && brands.length !== requestedBrands.length) {
    throw new Error(`Unknown brand in --brands. Available: ${TARGETS.map((brand) => brand.brand).join(", ")}`);
  }
  if (!brands.length) throw new Error("No brands selected");
  const brandQuota = argument("--brand-quota") ? Number(argument("--brand-quota")) : null;
  if (brandQuota !== null && (!Number.isInteger(brandQuota) || brandQuota < 1)) throw new Error("--brand-quota must be a positive integer");
  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const run = await client.from("import_runs").insert({ mode: "initial", status: "running", cursor: { source: "encar-model-raw-intake", readOnly: false, yearFrom: YEAR_FROM, yearTo: YEAR_TO, horsepowerMax: 160, target } }).select("id").single();
  if (run.error) throw new Error(run.error.message);
  const runId = run.data.id as string;
  const seen = new Set<string>();
  const known = new Set<string>();
  for (const table of ["encar_raw_listings", "vehicles"] as const) {
    for (let offset = 0; ; offset += 1_000) {
      const { data, error } = await client.from(table).select("source_listing_id").range(offset, offset + 999);
      if (error) throw new Error(`${table} query failed: ${error.message}`);
      for (const row of data ?? []) {
        if (row.source_listing_id) known.add(String(row.source_listing_id));
      }
      if (!data || data.length < 1_000) break;
    }
  }
  const rawRows: Record<string, unknown>[] = [];
  let scanned = 0;
  const summary: Array<Record<string, unknown>> = [];
  try {
    for (const brand of brands) {
      if (rawRows.length >= target) break;
      const collected = new Map<string, number>();
      let sourceTotal = 0;
      let pageCount = 0;
      for (const alias of MANUFACTURER_ALIASES[brand.brand] ?? [brand.manufacturer]) {
        for (let offset = 0; pageCount < MAX_PAGES_PER_ALIAS && rawRows.length < target; offset += PAGE_SIZE) {
          const page = await search(alias, offset);
          sourceTotal += page.total;
          pageCount += 1;
          if (!page.listings.length) break;
          scanned += page.listings.length;
          for (const listing of page.listings) {
            const id = String(listing.Id ?? "");
            if (!id || seen.has(id) || known.has(id)) continue;
            const model = brand.models.find((candidate) => matches(listing, candidate.terms));
            if (!model || (collected.get(model.name) ?? 0) >= model.target) continue;
            if (brandQuota !== null && [...collected.values()].reduce((sum, value) => sum + value, 0) >= brandQuota) continue;
            seen.add(id);
            collected.set(model.name, (collected.get(model.name) ?? 0) + 1);
            rawRows.push({ source_listing_id: id, import_run_id: runId, source_url: `https://www.encar.com/dc/dc_cardetailview.do?carid=${id}`, payload: listing, payload_hash: createHash("sha256").update(JSON.stringify(listing)).digest("hex"), last_seen_at: new Date().toISOString(), processed_at: null });
            if (rawRows.length >= target) break;
          }
          if (rawRows.length >= target) break;
          await delay(DELAY_MS);
        }
        if (rawRows.length >= target) break;
      }
      summary.push({ brand: brand.brand, sourceTotal, pages: pageCount, collected: Object.fromEntries(collected) });
      console.log(JSON.stringify({ brand: brand.brand, pages: pageCount, collected: Object.fromEntries(collected), totalRaw: rawRows.length, scanned }));
    }
    for (let offset = 0; offset < rawRows.length; offset += 500) {
      const batch = rawRows.slice(offset, offset + 500);
      const result = await client.from("encar_raw_listings").upsert(batch, { onConflict: "source_listing_id" });
      if (result.error) throw new Error(result.error.message);
    }
    const update = await client.from("import_runs").update({ status: "completed", finished_at: new Date().toISOString(), fetched_count: scanned, accepted_count: rawRows.length, rejected_count: 0, error_count: 0, cursor: { source: "encar-model-raw-intake", readOnly: false, yearFrom: YEAR_FROM, yearTo: YEAR_TO, horsepowerMax: 160, target, brands: brands.map((brand) => brand.brand), brandQuota, rawRows: rawRows.length, summary } }).eq("id", runId);
    if (update.error) throw new Error(update.error.message);
    console.log(JSON.stringify({ status: "completed", rawOnly: true, target, rawRows: rawRows.length, scanned, summary }));
  } catch (error) {
    await client.from("import_runs").update({ status: "failed", finished_at: new Date().toISOString(), error_count: 1, error_summary: [error instanceof Error ? error.message : String(error)] }).eq("id", runId);
    throw error;
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
