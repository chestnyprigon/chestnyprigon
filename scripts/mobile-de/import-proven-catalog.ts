import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const envCandidates = [process.env.DOTENV_CONFIG_PATH, ".env.local", "../../.env.local", ".env"]
  .filter((path): path is string => Boolean(path));
for (const path of envCandidates) if (existsSync(path)) loadEnv({ path });

const API_ROOT = (process.env.MASTER_MOBILE_DE_API_ROOT?.trim() || "https://api.koredigital.co.kr/v1/internal/mobile-de").replace(/\/+$/, "");
const IMPORT_CONCURRENCY = 12;
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const token = required("MASTER_MOBILE_DE_API_TOKEN");

async function main() {
const args = new Map(process.argv.slice(2).map((value) => {
  const [key, ...rest] = value.replace(/^--/, "").split("=");
  return [key, rest.join("=")];
}));
const write = args.get("write") === "true";
const supabase = write ? createClient(
  process.env.EUROPE_SUPABASE_URL?.trim() || required("NEXT_PUBLIC_SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
) : null;
const limit = Number(args.get("limit") ?? 100);
if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("--limit must be from 1 to 10000");
const allowlistPath = process.env.MOBILE_DE_PROVEN_ALLOWLIST_PATH?.trim();
if (!allowlistPath) throw new Error("MOBILE_DE_PROVEN_ALLOWLIST_PATH must point to the recovery export containing the exact 7,333 PROVEN/VERIFIED active Master IDs");

const allowlistCandidates = [resolve(allowlistPath), resolve("../../", allowlistPath)];
const allowlistFile = allowlistCandidates.find(existsSync);
if (!allowlistFile) throw new Error(`Allow-list file not found in the project or worktree: ${allowlistPath}`);
const allowlist = JSON.parse(await readFile(allowlistFile, "utf8")) as unknown;
const ids = Array.isArray(allowlist) ? allowlist : allowlist && typeof allowlist === "object" && "master_ids" in allowlist ? (allowlist as { master_ids: unknown }).master_ids : null;
if (!Array.isArray(ids) || ids.length !== 7_333 || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
  throw new Error("Allow-list must contain exactly 7,333 unique Master IDs");
}
const provenIds = ids as string[];
const cohort = args.get("cohort") ?? "proven";
if (!["proven", "customer", "all"].includes(cohort)) throw new Error("--cohort must be proven, customer, or all");
let customerIds: string[] = [];
if (cohort !== "proven") {
  const customerAllowlistPath = process.env.MOBILE_DE_CUSTOMER_ALLOWLIST_PATH?.trim();
  if (!customerAllowlistPath) throw new Error("MOBILE_DE_CUSTOMER_ALLOWLIST_PATH is required for the customer cohort");
  const customerAllowlistFile = [resolve(customerAllowlistPath), resolve("../../", customerAllowlistPath)].find(existsSync);
  if (!customerAllowlistFile) throw new Error("Customer allow-list file was not found");
  const customerAllowlist = JSON.parse(await readFile(customerAllowlistFile, "utf8")) as unknown;
  const customerValues = Array.isArray(customerAllowlist) ? customerAllowlist
    : customerAllowlist && typeof customerAllowlist === "object" && "master_ids" in customerAllowlist
      ? (customerAllowlist as { master_ids: unknown }).master_ids : null;
  if (!Array.isArray(customerValues) || customerValues.length < 1 || customerValues.length > 10_000
      || customerValues.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
      || new Set(customerValues).size !== customerValues.length) {
    throw new Error("Customer allow-list must contain 1-10,000 unique Master UUIDs");
  }
  customerIds = customerValues as string[];
  const provenSet = new Set(provenIds);
  if (customerIds.some((id) => provenSet.has(id))) throw new Error("Customer allow-list overlaps the existing 7,333-ID recovery cohort");
}
const cohortIds = cohort === "proven" ? provenIds : cohort === "customer" ? customerIds : [...new Set([...provenIds, ...customerIds])];
const requestedIds = [...cohortIds].sort().slice(0, limit);
const allowlistedMasterIds = new Set([...provenIds, ...customerIds]);

const priceCategories = new Set(["Sehr guter Preis", "Guter Preis", "Fairer Preis"]);
const proofAliases = new Set(["proven_verified", "PROVEN / VERIFIED", "PROVEN/VERIFIED"]);

let nextApiRequestAt = 0;
let requestSchedule = Promise.resolve();
async function reserveApiRequestSlot() {
  const previous = requestSchedule;
  let release!: () => void;
  requestSchedule = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const delay = Math.max(0, nextApiRequestAt - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    nextApiRequestAt = Date.now() + 1_050;
  } finally {
    release();
  }
}
async function getJson(path: string): Promise<unknown> {
  for (let attempt = 1; attempt <= 8; attempt++) {
    await reserveApiRequestSlot();
    try {
      const response = await fetch(`${API_ROOT}${path}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : Math.min(60_000, 2_000 * 2 ** (attempt - 1));
        nextApiRequestAt = Math.max(nextApiRequestAt, Date.now() + backoff);
        if (attempt === 8) throw new Error(`Master API rate limit persisted for ${path}`);
        continue;
      }
      if (response.status >= 500 && attempt < 8) {
        nextApiRequestAt = Math.max(nextApiRequestAt, Date.now() + Math.min(60_000, 2_000 * 2 ** (attempt - 1)));
        continue;
      }
      if (!response.ok) throw new Error(`Master API ${response.status} for ${path}`);
      return await response.json() as unknown;
    } catch (error) {
      if (attempt === 8 || (error instanceof Error && error.message.startsWith("Master API "))) throw error;
      nextApiRequestAt = Math.max(nextApiRequestAt, Date.now() + Math.min(60_000, 2_000 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`Master API request exhausted retries for ${path}`);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function nested(value: unknown, key: string) { return record(record(value)[key]); }
function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  const object = record(value);
  for (const key of ["label_ru", "text_ru", "value", "name", "original", "code"]) {
    if (typeof object[key] === "string" && (object[key] as string).trim()) return (object[key] as string).trim();
  }
  return null;
}
function number(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function array(value: unknown) { return Array.isArray(value) ? value : []; }
function proofStatus(item: Record<string, unknown>, allowlistedMasterIds: Set<string>) {
  const masterId = text(item.master_id);
  if (masterId && allowlistedMasterIds.has(masterId)) return "proven_verified";
  const quality = record(item.quality);
  const proof = text(item.proof_status ?? item.verification_status ?? quality.proof_status ?? quality.verification_status ?? item.status);
  const bothExplicitFlags = (item.proven === true || quality.proven === true) && (item.verified === true || quality.verified === true);
  return (proof && proofAliases.has(proof)) || bothExplicitFlags ? "proven_verified" : null;
}
function eligible(item: Record<string, unknown>, allowlistedMasterIds: Set<string>) {
  const masterId = text(item.master_id);
  const sourceId = text(item.source_id);
  const make = text(item.make);
  const registration = nested(item, "first_registration");
  const regValue = text(registration.value);
  const precision = text(registration.precision);
  const registrationYear = regValue ? Number(regValue.slice(0, 4)) : null;
  const price = nested(item, "price");
  const netPrice = nested(item, "net_price");
  const priceCategory = text(price.category ?? price.evaluation ?? item.price_category ?? item.price_evaluation ?? item.price_rating);
  const priceCategoryEligible = priceCategory
    ? priceCategories.has(priceCategory)
    : Boolean(masterId && allowlistedMasterIds.has(masterId));
  const priceAmount = number(price.gross_amount ?? price.amount);
  const netPriceAmount = number(netPrice.amount);
  const netPriceCurrency = text(netPrice.currency);
  const netPriceBasis = text(netPrice.basis)?.toLowerCase();
  const netPriceSourcePath = text(netPrice.source_path);
  const netPriceStatus = text(netPrice.status);
  const netPriceObservedAt = text(netPrice.observed_at ?? netPrice.source_observed_at);
  const netPriceObservedAtValid = Boolean(netPriceObservedAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(netPriceObservedAt) && Number.isFinite(Date.parse(netPriceObservedAt)));
  const power = nested(item, "power");
  const powerValue = number(power.value);
  const mileage = number(item.mileage_km);
  const freshness = nested(item, "freshness");
  const sourceUpdatedAt = text(freshness.source_updated_at);
  const sourceUpdatedAtValid = Boolean(sourceUpdatedAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(sourceUpdatedAt) && Number.isFinite(Date.parse(sourceUpdatedAt)));
  const sourceStatus = text(item.source_status ?? freshness.availability);
  const normalizedSourceStatus = sourceStatus?.toLowerCase();
  const isNewVehicle = item.is_new_vehicle === true || text(item.vehicle_type)?.toLowerCase() === "neuwagen" || !regValue || precision === "unknown";
  const vehicleClass = text(item.transport_class)?.toUpperCase() === "VAN" ? "VAN" : "CAR";
  const images = array(item.gallery).flatMap((entry) => {
    const image = record(entry);
    const url = text(image.url);
    if (!url) return [];
    return [{ master_id: masterId!, source_url: url, position: number(image.position) ?? 0, is_primary: image.is_primary === true }];
  });
  const primaryImageUrl = text(nested(item, "primary_image").url);
  if (primaryImageUrl && !images.some((image) => image.source_url === primaryImageUrl)) {
    images.push({ master_id: masterId!, source_url: primaryImageUrl, position: 0, is_primary: true });
  }
  const verified = proofStatus(item, allowlistedMasterIds);
  const active = item.active === true || item.is_active === true || normalizedSourceStatus === "active" ||
    (verified === "proven_verified" && (!normalizedSourceStatus || normalizedSourceStatus === "unknown"));

  const sourceNettoValid = Boolean(netPriceAmount && netPriceCurrency === "EUR" && netPriceBasis === "netto"
    && netPriceStatus === "source_reported" && netPriceSourcePath === "price.nt.amount" && netPriceObservedAtValid);
  if (!masterId || !sourceId || !make || !verified || !active || !regValue || !precision || ["unknown", "year", "neuwagen"].includes(precision.toLowerCase()) || !registrationYear || registrationYear < 2022 || registrationYear > 2025 ||
    !priceCategoryEligible || !priceAmount || text(price.currency) !== "EUR" || !sourceUpdatedAtValid || !item.engine_cc || !number(item.engine_cc) || !powerValue || powerValue > 160 || !mileage && mileage !== 0 || mileage > 100_000 || isNewVehicle) return null;
  const title = text(item.title) || [make, text(item.model)].filter(Boolean).join(" ");
  const sourceUrl = text(item.source_url) || `https://suchen.mobile.de/fahrzeuge/details.html?id=${encodeURIComponent(sourceId)}`;
  return {
    listing: {
      master_id: masterId, source_id: sourceId, title, make, model: text(item.model),
      first_registration: regValue,
      first_registration_precision: precision, registration_year: registrationYear,
      mileage_km: mileage, engine_cc: number(item.engine_cc), power_ps: powerValue,
      price_amount: priceAmount, price_currency: text(price.currency) || "EUR", source_price_basis: "gross",
      source_price_source_path: text(price.source_path) || "price.grs.amount",
      vehicle_class: vehicleClass, net_price_amount: sourceNettoValid ? netPriceAmount : null,
      net_price_source_path: sourceNettoValid ? netPriceSourcePath : null,
      price_status: sourceNettoValid ? "source_reported" : null,
      net_price_observed_at: sourceNettoValid ? netPriceObservedAt : null,
      price_category: priceCategory,
      price_category_eligible: priceCategoryEligible,
      fuel_type: text(item.fuel_type ?? item.fuel), transmission: text(item.transmission), drive: text(item.drive),
      body_type: text(item.body_type ?? item.body), color: text(item.color ?? item.color_ru), description: text(item.description),
      options: Array.isArray(item.options) ? item.options : [], source_url: sourceUrl,
      primary_image_url: primaryImageUrl || images[0]?.source_url || null,
      source_status: "active", proof_status: "proven_verified", is_new_vehicle: false,
      catalog_visible: true, source_updated_at: sourceUpdatedAt,
      last_seen_at: text(freshness.last_seen_at), verified_at: text(freshness.last_successful_source_check_at),
      source_payload: {
        proof_status: text(item.proof_status ?? item.verification_status),
        source_status: sourceStatus,
        proof_reference: text(item.proof_reference ?? item.proof_id),
        price_category_eligibility_basis: priceCategory ? "master_api_detail" : "filtered_candidate_cohort_allowlist",
      },
    },
    priceEvidence: {
      master_id: masterId,
      net_price_amount: sourceNettoValid ? netPriceAmount : null,
      currency: netPriceCurrency,
      price_basis: sourceNettoValid ? "netto" : "gross",
      price_status: sourceNettoValid ? netPriceStatus : "source_reported",
      vat_deductibility: "UNKNOWN",
      net_price_source_path: netPriceSourcePath,
      asking_price_observed: priceAmount,
      source_updated_at_observed: sourceUpdatedAt,
      source_price_evidence: {
        amount: sourceNettoValid ? netPriceAmount : priceAmount,
        currency: text(price.currency) || "EUR",
        basis: sourceNettoValid ? "netto" : "gross",
        source_path: sourceNettoValid ? netPriceSourcePath : "price.grs.amount",
        status: "source_reported",
        source_observed_at: sourceNettoValid ? netPriceObservedAt : text(price.observed_at),
      },
      verified_at: new Date().toISOString(),
      approved: true,
    },
    images: [...new Map(images.map((image) => [image.source_url, image])).values()]
      .sort((a, b) => a.position - b.position)
      .map((image, position) => ({ ...image, position, is_primary: position === 0 })),
  };
}

// Keep this cache version isolated from the earlier Netto-only mapping; cached
// payloads may predate the gross-price and transport-class API fields.
const cacheDirectory = resolve(process.env.MOBILE_DE_IMPORT_CACHE_DIR?.trim() || ".local/mobile-de-import-cache-v3-van-gross");
await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
let cacheHits = 0;
let checkedCount = 0;
let nextIndex = 0;
const results: Array<{ id: string; mapped: ReturnType<typeof eligible>; reason: string | null }> = new Array(requestedIds.length);
async function checkListing(index: number) {
  const id = requestedIds[index];
  const cacheFile = resolve(cacheDirectory, `${id}.json`);
  let payload: unknown;
  if (existsSync(cacheFile)) {
    try {
      payload = JSON.parse(await readFile(cacheFile, "utf8")) as unknown;
      cacheHits++;
    } catch {
      payload = await getJson(`/listings/${encodeURIComponent(id)}`);
      await writeFile(cacheFile, JSON.stringify(payload), { mode: 0o600 });
    }
  } else {
    payload = await getJson(`/listings/${encodeURIComponent(id)}`);
    await writeFile(cacheFile, JSON.stringify(payload), { mode: 0o600 });
  }
  const payloadRecord = record(payload);
  const item = record(payloadRecord.data ?? payloadRecord);
  const mapped = eligible(item, allowlistedMasterIds);
  if (!mapped) {
    const price = nested(item, "price");
    const grossAmount = number(price.gross_amount ?? price.amount);
    const category = text(price.category ?? price.evaluation ?? item.price_category ?? item.price_evaluation ?? item.price_rating);
    const reason = category && !priceCategories.has(category)
      ? "Explicit price category is outside the allowed low/mid set"
      : !grossAmount || text(price.currency) !== "EUR"
        ? "Master API does not provide a source-reported EUR asking price"
        : !text(nested(item, "first_registration").value) || !number(item.engine_cc)
          ? "First registration or engine displacement is missing"
          : "Failed active status, registration, power, mileage, or required-field check";
    results[index] = { id, mapped: null, reason };
  } else {
    results[index] = { id, mapped, reason: null };
  }
  checkedCount++;
  if (checkedCount % 100 === 0 || checkedCount === requestedIds.length) {
    const accepted = results.reduce((count, result) => count + (result?.mapped ? 1 : 0), 0);
    console.log(`Checked ${checkedCount}/${requestedIds.length} listings (${cacheHits} resumed from local cache; ${accepted} eligible)`);
  }
}
async function worker() {
  while (true) {
    const index = nextIndex++;
    if (index >= requestedIds.length) return;
    await checkListing(index);
  }
}
const workerResults = await Promise.allSettled(Array.from({ length: Math.min(IMPORT_CONCURRENCY, requestedIds.length) }, () => worker()));
const workerFailure = workerResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
if (workerFailure) throw workerFailure.reason;
const batch = results.flatMap((result) => result.mapped ? [result.mapped] : []);
const skipped = results.flatMap((result) => result.reason ? [{ id: result.id, reason: result.reason }] : []);

const summary = { mode: write ? "write" : "dry-run", cohort, allowlisted: requestedIds.length, fetched: requestedIds.length, accepted: batch.length, skippedCount: skipped.length, skippedSample: skipped.slice(0, 10), photoRows: batch.reduce((sum, row) => sum + row.images.length, 0), netPriceRows: batch.filter((row) => row.listing.net_price_amount !== null).length, vanRows: batch.filter((row) => row.listing.vehicle_class === "VAN").length };
if (!write) { console.log(JSON.stringify(summary, null, 2)); process.exit(0); }
if (cohort !== "customer") throw new Error("Writes are enabled only for the separate customer allow-list cohort");
if (!supabase) throw new Error("Supabase write client was not initialized");
if (args.get("confirm") !== `mobile-de-${cohort}-import`) throw new Error(`Writing requires --confirm=mobile-de-${cohort}-import`);

const runInsert = await supabase.from("mobile_de_catalog_import_runs").insert({
  status: "running", source_candidate_count: requestedIds.length, fetched_count: requestedIds.length,
  proven_count: batch.length, rejected_count: skipped.length,
}).select("id").single();
if (runInsert.error || !runInsert.data?.id) throw new Error(`Could not create Europe import run: ${runInsert.error?.message ?? "missing run id"}`);
const runId = runInsert.data.id;
let upsertedCount = 0;
try {
  for (let offset = 0; offset < batch.length; offset += 100) {
    const page = batch.slice(offset, offset + 100);
    const listingRows = page.map((row) => row.listing);
    const listingsResult = await supabase.from("mobile_de_catalog_listings").upsert(listingRows, { onConflict: "master_id" });
    if (listingsResult.error) throw new Error(`Europe listing upsert failed: ${listingsResult.error.message}`);
    const imageRows = page.flatMap((row) => row.images);
    for (let imageOffset = 0; imageOffset < imageRows.length; imageOffset += 500) {
      const imageResult = await supabase.from("mobile_de_catalog_images").upsert(imageRows.slice(imageOffset, imageOffset + 500), { onConflict: "master_id,position" });
      if (imageResult.error) throw new Error(`Europe gallery upsert failed: ${imageResult.error.message}`);
    }
    upsertedCount += page.length;
  }
  const completed = await supabase.from("mobile_de_catalog_import_runs").update({ status: "completed", upserted_count: upsertedCount, finished_at: new Date().toISOString() }).eq("id", runId);
  if (completed.error) throw new Error(`Europe import run completion update failed: ${completed.error.message}`);
} catch (error) {
  await supabase.from("mobile_de_catalog_import_runs").update({ status: "failed", upserted_count: upsertedCount, finished_at: new Date().toISOString(), error_summary: [{ message: error instanceof Error ? error.message : "unknown_write_error" }] }).eq("id", runId);
  throw error;
}
console.log(JSON.stringify({ ...summary, status: "completed", run_id: runId, upserted: upsertedCount }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Unknown import error");
  process.exitCode = 1;
});
