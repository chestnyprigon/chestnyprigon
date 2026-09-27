import fs from "node:fs/promises";
import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { normalizeListing } from "../encar/normalize";
import { screenListing } from "../encar/screening";
import { ENCAR_MAX_LISTING_AGE_DAYS } from "../encar/config";
import type { EncarBundle } from "../encar/types";
import { MANUFACTURER_ALIASES } from "../encar/manufacturer-aliases";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const LIMIT = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.slice(8) ?? 5_000);
const MAX_AGE_DAYS = ENCAR_MAX_LISTING_AGE_DAYS;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function ageInDays(value: unknown, now: number) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? (now - timestamp) / 86_400_000 : null;
}

function canonicalBrand(value: unknown) {
  const source = String(value ?? "").trim();
  const match = Object.entries(MANUFACTURER_ALIASES).find(([, aliases]) => aliases.some((alias) => source.includes(alias)));
  return match?.[0] ?? source;
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function main() {
  if (!Number.isInteger(LIMIT) || LIMIT < 1 || LIMIT > 20_000) throw new Error("--limit must be an integer from 1 to 20000");
  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const known = new Set<string>();
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await client.from("vehicles").select("source_listing_id").range(offset, offset + 999);
    if (error) throw new Error(`Catalog query failed: ${error.message}`);
    for (const row of data ?? []) known.add(String(row.source_listing_id));
    if (!data || data.length < 1_000) break;
  }

  const raw: Array<{ source_listing_id: string; payload: EncarBundle; last_seen_at: string }> = [];
  for (let offset = 0; raw.length < LIMIT; offset += 1_000) {
    const { data, error } = await client.from("encar_raw_listings").select("source_listing_id,payload,last_seen_at").order("last_seen_at", { ascending: false }).range(offset, Math.min(offset + 999, LIMIT - 1));
    if (error) throw new Error(`Raw reserve query failed: ${error.message}`);
    raw.push(...((data ?? []) as typeof raw));
    if (!data || data.length < 1_000) break;
  }

  const now = Date.now();
  const selected: Array<Record<string, unknown>> = [];
  const rejected: Record<string, number> = {};
  let alreadyKnown = 0;
  let stale = 0;
  let fullBundles = 0;
  let listOnly = 0;
  let needsDetail = 0;
  let rejectedRows = 0;
  for (const row of raw) {
    const id = String(row.source_listing_id);
    if (known.has(id)) { alreadyKnown += 1; continue; }
    const bundle = row.payload;
    if (!bundle?.detail || !bundle?.search) {
      listOnly += 1;
      const listing = record(bundle);
      const brand = canonicalBrand(listing.Manufacturer);
      const model = String(listing.Model ?? "").trim();
      const year = number(listing.Year) !== null && Number(listing.Year) >= 190000 ? Math.floor(Number(listing.Year) / 100) : number(listing.FormYear);
      const mileage = number(listing.Mileage);
      const fuel = String(listing.FuelType ?? "").toLowerCase();
      const offerType = String(listing.SellType ?? "").trim();
      const reasons: string[] = [];
      if (!brand || !MANUFACTURER_ALIASES[brand]) reasons.push("brand_not_in_catalog_scope");
      if (!model || year === null) reasons.push("missing_basic_details");
      if (year !== null && year < 2016) reasons.push("model_year_before_2016");
      if (mileage === null) reasons.push("missing_mileage");
      else if (mileage > 190_000) reasons.push("mileage_over_190000");
      if (offerType && !["일반", "일반매물", "판매", "sale"].includes(offerType)) reasons.push("not_sale_offer");
      if (/전기|electric|hydrogen|수소|\bev\b/u.test(fuel)) reasons.push("unsupported_powertrain");
      if (reasons.length) {
        rejectedRows += 1;
        for (const reason of reasons) rejected[reason] = (rejected[reason] ?? 0) + 1;
        continue;
      }
      needsDetail += 1;
      selected.push({ sourceListingId: id, manufacturer: brand, model, modelYear: year, mileageKm: mileage, priceKrw: number(listing.Price) ? Number(listing.Price) * 10_000 : null, photoCount: Array.isArray(listing.Photos) ? listing.Photos.length : 0, reportExists: false, screening: "preliminary", requiresDetail: true, sourceUpdatedAt: null, rawLastSeenAt: row.last_seen_at });
      continue;
    }
    fullBundles += 1;
    const manage = record(record(bundle?.detail).manage);
    const age = ageInDays(manage.modifyDateTime ?? manage.firstAdvertisedDateTime, now);
    if (age === null || age > MAX_AGE_DAYS) { stale += 1; rejectedRows += 1; rejected.stale_over_180_days = (rejected.stale_over_180_days ?? 0) + 1; continue; }
    const screening = screenListing(bundle);
    if (screening.decision !== "approved") {
      rejectedRows += 1;
      for (const reason of screening.reasonCodes) rejected[reason] = (rejected[reason] ?? 0) + 1;
      continue;
    }
    const normalized = normalizeListing(bundle);
    const advertisement = record(record(bundle.detail).advertisement);
    const verification = record(advertisement.verification);
    selected.push({ sourceListingId: id, manufacturer: normalized.manufacturer, model: normalized.model, modelYear: normalized.modelYear, mileageKm: normalized.mileageKm, priceKrw: normalized.priceKrw, photoCount: normalized.imageUrls.length, reportExists: verification.reportExists === true, screening: screening.decision, sourceUpdatedAt: manage.modifyDateTime ?? manage.firstAdvertisedDateTime, rawLastSeenAt: row.last_seen_at });
  }

  const byBrand: Record<string, number> = {};
  for (const item of selected) { const brand = String(item.manufacturer); byBrand[brand] = (byBrand[brand] ?? 0) + 1; }
  const output = { status: "completed", mode: "read-only", source: "public.encar_raw_listings", project: "chestny-prigon", rules: { maxAgeDays: MAX_AGE_DAYS, minYear: 2016, maxMileageKm: 190_000, noLeaseRentalCommercial: true, noElectricHydrogen: true }, summary: { rawRows: raw.length, fullBundles, listOnly, alreadyKnown, stale, selected: selected.length, needsDetail, rejected: rejectedRows, rejectionReasonMatches: Object.values(rejected).reduce((sum, value) => sum + value, 0), rejectionReasons: rejected }, byBrand, candidates: selected };
  await fs.mkdir(path.resolve(process.cwd(), "output"), { recursive: true });
  await fs.writeFile(path.resolve(process.cwd(), "output/radar-local-candidates.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...output, candidates: selected.slice(0, 30), candidateFile: "output/radar-local-candidates.json" }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
