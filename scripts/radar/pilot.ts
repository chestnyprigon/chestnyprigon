import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const DEFAULT_LIMIT = 200;
const ALLOWED_OFFER_TYPES = new Set(["sale", "일반", "일반매물", "판매"]);
const ALLOWED_BRANDS = new Set([
  "Hyundai", "Kia", "Genesis", "BMW", "Mercedes-Benz", "Audi", "Volkswagen",
  "Porsche", "Volvo", "Land Rover", "Lexus", "Jaguar", "MINI", "Toyota",
  "Nissan", "Mazda", "Honda", "Subaru", "Chevrolet", "ChevroletGMDaewoo",
  "Mitsubishi", "Ford", "Jeep", "Renault Korea", "KGM",
]);

type RadarEvent = {
  id: string;
  canonical_encar_id: string;
  detected_at: string;
  published_at: string | null;
  event_type?: string | null;
  current_state: Record<string, unknown> | null;
};

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function limitArgument() {
  const raw = process.argv.find((argument) => argument.startsWith("--limit="))?.slice("--limit=".length);
  const value = raw === undefined ? DEFAULT_LIMIT : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 2_000) throw new Error("--limit must be an integer from 1 to 2000");
  return value;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function main() {
  const limit = limitArgument();
  const radarUrl = process.env.RADAR_SUPABASE_URL?.trim() || required("NEXT_PUBLIC_SUPABASE_URL");
  const radarKey = process.env.RADAR_SUPABASE_SERVICE_ROLE_KEY?.trim() || required("SUPABASE_SERVICE_ROLE_KEY");
  const catalogUrl = required("NEXT_PUBLIC_SUPABASE_URL");
  const catalogKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const radar = createClient(radarUrl, radarKey, { auth: { persistSession: false, autoRefreshToken: false } }).schema("radar");
  const publicClient = createClient(catalogUrl, catalogKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: events, error: eventError } = await radar
    .from("listing_events")
    .select("id,canonical_encar_id,detected_at,published_at,event_type,current_state")
    .in("event_type", ["new_listing", "late_discovered"])
    .order("detected_at", { ascending: false })
    .limit(limit);
  if (eventError) throw new Error(`Radar query failed: ${eventError.message}`);

  const ids = Array.from(new Set((events ?? []).map((event) => String(event.canonical_encar_id)).filter(Boolean)));
  const known = new Set<string>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await publicClient.from("vehicles").select("source_listing_id").range(offset, offset + 999);
    if (error) throw new Error(`Catalog query failed: ${error.message}`);
    for (const row of data ?? []) known.add(String(row.source_listing_id));
    if (!data || data.length < 1000) break;
  }

  const summary = { requested: limit, events: events?.length ?? 0, uniqueIds: ids.length, alreadyInCatalog: 0, candidates: 0, rejected: 0, missingDetails: 0, rejectionReasons: {} as Record<string, number> };
  const brandCounts: Record<string, number> = {};
  const modelCounts: Record<string, number> = {};
  const candidates: Array<Record<string, unknown>> = [];
  for (const rawEvent of (events ?? []) as RadarEvent[]) {
    const id = String(rawEvent.canonical_encar_id);
    if (known.has(id)) { summary.alreadyInCatalog += 1; continue; }
    const state = rawEvent.current_state ?? {};
    const offerType = text(state.offerType || state.offer_type || state.sellType || state.sell_type);
    const brand = text(state.brand || state.manufacturer || state.make);
    const model = text(state.model);
    const year = number(state.year || state.modelYear || state.model_year);
    const mileage = number(state.mileageKm || state.mileage_km || state.mileage);
    const fuel = text(state.fuelType || state.fuel_type || state.fuel).toLowerCase();
    const reasons: string[] = [];
    if (!brand || !model || !year) reasons.push("missing_basic_details");
    if (brand && !ALLOWED_BRANDS.has(brand)) reasons.push("brand_not_in_catalog_scope");
    if (year !== null && year < 2016) reasons.push("model_year_before_2016");
    if (mileage === null) reasons.push("missing_mileage");
    else if (mileage > 190_000) reasons.push("mileage_over_190000");
    if (offerType && !ALLOWED_OFFER_TYPES.has(offerType)) reasons.push("not_sale_offer");
    if (/전기|electric|hydrogen|수소|\bev\b/u.test(fuel)) reasons.push("unsupported_powertrain");
    if (reasons.length) {
      summary.rejected += 1;
      if (reasons.includes("missing_basic_details") || reasons.includes("missing_mileage")) summary.missingDetails += 1;
      for (const reason of reasons) summary.rejectionReasons[reason] = (summary.rejectionReasons[reason] ?? 0) + 1;
      continue;
    }
    summary.candidates += 1;
    brandCounts[brand] = (brandCounts[brand] ?? 0) + 1;
    const modelKey = `${brand} ${model}`;
    modelCounts[modelKey] = (modelCounts[modelKey] ?? 0) + 1;
    candidates.push({ encarId: id, brand, model, year, priceKrw: number(state.priceKrw || state.price_krw), detectedAt: rawEvent.detected_at });
  }

  const byCount = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
  console.log(JSON.stringify({ status: "completed", mode: "read-only", source: "radar.listing_events", project: "chestny-prigon", summary, byBrand: byCount(brandCounts), topModels: Object.fromEntries(Object.entries(byCount(modelCounts)).slice(0, 30)), candidates }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
