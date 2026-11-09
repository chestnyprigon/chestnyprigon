import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { normalizeMobileDeField, normalizeMobileDeOptions } from "@/lib/mobile-de/localization";

const envCandidates = [process.env.DOTENV_CONFIG_PATH, ".env.local", "../../.env.local", ".env"]
  .filter((path): path is string => Boolean(path));
for (const path of envCandidates) if (existsSync(path)) loadEnv({ path });

const API_ROOT = "https://api.koredigital.co.kr/v1/internal/mobile-de";
const IMPORT_CONCURRENCY = 12;
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const token = required("MASTER_MOBILE_DE_API_TOKEN");
const supabase = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
const args = new Map(process.argv.slice(2).map((value) => {
  const [key, ...rest] = value.replace(/^--/, "").split("=");
  return [key, rest.join("=")];
}));
const write = args.get("write") === "true";
const limit = Number(args.get("limit") ?? 100);
if (!Number.isInteger(limit) || limit < 1 || limit > 7_333) throw new Error("--limit must be from 1 to 7333");
const customerAllowlistPath = process.env.MOBILE_DE_CUSTOMER_ALLOWLIST_PATH?.trim();
const legacyAllowlistPath = process.env.MOBILE_DE_PROVEN_ALLOWLIST_PATH?.trim();
const isCustomerCohort = Boolean(customerAllowlistPath);
const allowlistPath = customerAllowlistPath || legacyAllowlistPath;
if (!allowlistPath) throw new Error("Set MOBILE_DE_CUSTOMER_ALLOWLIST_PATH for the explicit customer cohort, or MOBILE_DE_PROVEN_ALLOWLIST_PATH for the legacy 7,333-listing import");
const allowlistCandidates = [resolve(allowlistPath), resolve("../../", allowlistPath)];
const allowlistFile = allowlistCandidates.find(existsSync);
if (!allowlistFile) throw new Error(`Allow-list file not found in the project or worktree: ${allowlistPath}`);
const allowlist = JSON.parse(await readFile(allowlistFile, "utf8")) as unknown;
const customerModelGroups = new Set([
  "Renault Megane", "Peugeot 308", "Peugeot 3008", "Citroen Spacetourer", "Citroen Grand C4 Spacetourer",
  "SEAT Ateca", "Opel Insignia", "Mercedes Sprinter", "Volkswagen Crafter", "MAN TGE", "Fiat Ducato",
]);
const records = allowlist && typeof allowlist === "object" && "listings" in allowlist ? (allowlist as { listings: unknown }).listings : null;
const ids = !isCustomerCohort && (Array.isArray(allowlist) ? allowlist : allowlist && typeof allowlist === "object" && "master_ids" in allowlist ? (allowlist as { master_ids: unknown }).master_ids : null);
if (isCustomerCohort && (!Array.isArray(records) || records.length !== 3_860 || new Set(records.map((row) => text(record(row).master_id))).size !== 3_860)) {
  throw new Error("Customer allow-list must contain exactly 3,860 unique Master listing records");
}
if (isCustomerCohort) {
  const cohortRows = records as unknown[];
  const sourceIds = cohortRows.map((row) => text(record(row).source_id));
  const classes = cohortRows.reduce<{ CAR: number; VAN: number }>((counts, row) => {
    const vehicleClass = text(record(row).vehicle_class);
    if (vehicleClass === "CAR" || vehicleClass === "VAN") counts[vehicleClass]++;
    else throw new Error("Customer allow-list contains an unsupported transport class");
    if (!customerModelGroups.has(text(record(row).model_group) || "")) throw new Error("Customer allow-list contains an unapproved model group");
    return counts;
  }, { CAR: 0, VAN: 0 });
  if (sourceIds.some((id) => !id) || new Set(sourceIds).size !== 3_860 || classes.CAR !== 2_997 || classes.VAN !== 863) {
    throw new Error("Customer allow-list must have unique Source IDs and class counts CAR=2,997 / VAN=863");
  }
}
if (!isCustomerCohort && (!Array.isArray(ids) || ids.length !== 7_333 || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length)) {
  throw new Error("Legacy allow-list must contain exactly 7,333 unique Master IDs");
}
const cohortById = new Map<string, Record<string, unknown>>((isCustomerCohort ? records as unknown[] : []).map((row) => [String(record(row).master_id), record(row)]));
const idList = isCustomerCohort ? [...cohortById.keys()] : ids as string[];
const requestedIds = [...idList].sort().slice(0, limit);
const allowlistedMasterIds = new Set(idList);
const customerSourceToMaster = new Map([...cohortById.values()].map((row) => [String(row.source_id), String(row.master_id)]));

const priceCategories = new Set(["Sehr guter Preis", "Guter Preis", "Fairer Preis"]);
const proofAliases = new Set(["proven_verified", "PROVEN / VERIFIED", "PROVEN/VERIFIED"]);

let nextApiRequestAt = 0;
const apiRequestIntervalMs = Number(process.env.MOBILE_DE_API_INTERVAL_MS ?? (isCustomerCohort ? 1_250 : 1_050));
if (!Number.isFinite(apiRequestIntervalMs) || apiRequestIntervalMs < 100 || apiRequestIntervalMs > 60_000) throw new Error("MOBILE_DE_API_INTERVAL_MS must be from 100 to 60000");
let requestSchedule = Promise.resolve();
async function reserveApiRequestSlot() {
  const previous = requestSchedule;
  let release!: () => void;
  requestSchedule = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const delay = Math.max(0, nextApiRequestAt - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    nextApiRequestAt = Date.now() + apiRequestIntervalMs;
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
  const priceCategory = text(price.category ?? price.evaluation ?? item.price_category ?? item.price_evaluation ?? item.price_rating);
  const priceCategoryEligible = priceCategory
    ? priceCategories.has(priceCategory)
    : Boolean(masterId && allowlistedMasterIds.has(masterId));
  const priceAmount = number(price.amount);
  const power = nested(item, "power");
  const powerValue = number(power.value);
  const mileage = number(item.mileage_km);
  const freshness = nested(item, "freshness");
  const sourceStatus = text(item.source_status ?? freshness.availability);
  const normalizedSourceStatus = sourceStatus?.toLowerCase();
  const isNewVehicle = item.is_new_vehicle === true || text(item.vehicle_type)?.toLowerCase() === "neuwagen" || !regValue || precision === "unknown";
  const images = array(item.gallery).flatMap((entry) => {
    const image = record(entry);
    const url = text(image.url);
    if (!url) return [];
    return [{ master_id: masterId!, source_url: url, position: number(image.position) ?? 0, is_primary: image.is_primary === true }];
  });
  const verified = proofStatus(item, allowlistedMasterIds);
  const active = item.active === true || item.is_active === true || normalizedSourceStatus === "active" ||
    (verified === "proven_verified" && (!normalizedSourceStatus || normalizedSourceStatus === "unknown"));

  if (!masterId || !sourceId || !make || !verified || !active || !regValue || !precision || ["unknown", "year", "neuwagen"].includes(precision.toLowerCase()) || !registrationYear || registrationYear < 2022 || registrationYear > 2025 ||
    !priceCategoryEligible || !priceAmount || !powerValue || powerValue > 160 || !mileage && mileage !== 0 || mileage > 100_000 || isNewVehicle) return null;
  const title = text(item.title) || [make, text(item.model)].filter(Boolean).join(" ");
  const sourceUrl = text(item.source_url) || `https://suchen.mobile.de/fahrzeuge/details.html?id=${encodeURIComponent(sourceId)}`;
  return {
    listing: {
      master_id: masterId, source_id: sourceId, title, make, model: text(item.model),
      production_year: number(item.production_year), first_registration: regValue,
      first_registration_precision: precision, registration_year: registrationYear,
      mileage_km: mileage, engine_cc: number(item.engine_cc), power_ps: powerValue,
      price_amount: priceAmount, price_currency: text(price.currency) || "EUR", price_category: priceCategory,
      price_category_eligible: priceCategoryEligible,
      fuel_type: text(item.fuel_type ?? item.fuel), transmission: text(item.transmission), drive: text(item.drive),
      body_type: text(item.body_type ?? item.body), color: text(item.color ?? item.color_ru), description: text(item.description),
      options: Array.isArray(item.options) ? item.options : [], source_url: sourceUrl,
      primary_image_url: text(nested(item, "primary_image").url) || images[0]?.source_url || null,
      source_status: "active", proof_status: "proven_verified", is_new_vehicle: false,
      catalog_visible: true, source_updated_at: text(freshness.source_updated_at),
      last_seen_at: text(freshness.last_seen_at), verified_at: text(freshness.last_successful_source_check_at),
      source_payload: {
        proof_status: text(item.proof_status ?? item.verification_status),
        source_status: sourceStatus,
        proof_reference: text(item.proof_reference ?? item.proof_id),
        price_category_eligibility_basis: priceCategory ? "master_api_detail" : "filtered_candidate_cohort_allowlist",
        verified_at: text(freshness.last_successful_source_check_at),
      },
    },
    images: [...new Map(images.map((image) => [`${image.position}:${image.source_url}`, image])).values()],
  };
}

function eligibleCustomerCohort(item: Record<string, unknown>, cohort: Record<string, unknown>) {
  const masterId = text(cohort.master_id);
  const sourceId = text(cohort.source_id);
  const vehicleClass = text(cohort.vehicle_class);
  const modelGroup = text(cohort.model_group);
  const registration = nested(item, "first_registration");
  const rawRegValue = text(registration.value);
  const sourcePrecision = text(registration.precision)?.toLowerCase();
  const precision = sourcePrecision === "day" || sourcePrecision === "month" || sourcePrecision === "year" ? sourcePrecision : "year";
  const regValue = rawRegValue ? precision === "year" ? rawRegValue.slice(0, 4) : precision === "month" ? rawRegValue.slice(0, 7) : rawRegValue.slice(0, 10) : null;
  const registrationYear = regValue ? Number(regValue.slice(0, 4)) : null;
  const mileage = number(item.mileage_km);
  const fuel = text(nested(item, "fuel").code ?? item.fuel_type ?? item.fuel);
  const price = nested(item, "price");
  const reportedNet = nested(item, "net_price");
  const netAmount = text(reportedNet.status) === "source_reported" && text(reportedNet.basis) === "netto"
    ? number(reportedNet.amount)
    : null;
  const grossAmount = number(price.gross_amount) ?? number(price.amount);
  const priceAmount = netAmount && netAmount > 0 ? netAmount : grossAmount;
  const priceBasis = netAmount && netAmount > 0 ? "netto" : "brutto";
  const freshness = nested(item, "freshness");
  const availability = (text(freshness.availability) || "unknown").toLowerCase();
  const images = array(item.gallery).flatMap((entry) => {
    const image = record(entry);
    const url = text(image.url);
    if (!url) return [];
    return [{ master_id: masterId!, source_url: url, position: number(image.position) ?? 0, is_primary: image.is_primary === true }];
  });
  const currentSourceId = text(item.source_id);
  if (!masterId || !sourceId || currentSourceId !== sourceId || !modelGroup || !["CAR", "VAN"].includes(vehicleClass ?? "") ||
      !regValue || !registrationYear || registrationYear < 2022 || registrationYear > 2023 ||
      !Number.isFinite(mileage) || mileage! < 0 || mileage! > (vehicleClass === "VAN" ? 150_000 : 100_000) ||
      (vehicleClass === "VAN" && fuel?.toUpperCase() !== "DIESEL") || !priceAmount || priceAmount <= 0 ||
      text(price.currency) !== "EUR" || !images.length || availability === "unavailable" || availability === "removed") return null;

  const modelParts = modelGroup.split(/\s+/);
  const make = text(item.make) || modelParts.shift()!;
  const model = text(item.model) || modelParts.join(" ") || modelGroup;
  const title = text(item.title) || `${make} ${model}`;
  const sourceUrl = text(item.source_url) || `https://suchen.mobile.de/fahrzeuge/details.html?id=${encodeURIComponent(sourceId)}`;
  return {
    listing: {
      master_id: masterId, source_id: sourceId, title, make, model,
      model_group: modelGroup, transport_class: vehicleClass, customer_cohort: "customer_europe_2026",
      production_year: number(item.production_year), first_registration: regValue,
      first_registration_precision: precision, registration_year: registrationYear,
      mileage_km: mileage, engine_cc: number(item.engine_cc), power_ps: number(nested(item, "power").value),
      price_amount: priceAmount, price_currency: "EUR", price_category: text(price.category),
      price_category_eligible: true, source_gross_amount: grossAmount,
      reported_net_amount: netAmount, price_basis: priceBasis,
      price_provenance: { basis: priceBasis, source_path: priceBasis === "netto" ? text(reportedNet.source_path) || "price.nt.amount" : text(price.source_path) || "price.grs.amount", provenance: price.provenance ?? null },
      fuel_type: fuel, transmission: normalizeMobileDeField(text(item.transmission), "transmission"),
      drive: normalizeMobileDeField(text(nested(item, "drive").code ?? item.drive), "drive"),
      body_type: normalizeMobileDeField(text(nested(item, "body").code ?? item.body_type ?? item.body), "body"),
      color: normalizeMobileDeField(text(item.color ?? item.color_ru), "color"), description: text(item.description),
      options: normalizeMobileDeOptions(item.options), source_url: sourceUrl,
      primary_image_url: text(nested(item, "primary_image").url) || images.find((image) => image.is_primary)?.source_url || images[0]?.source_url || null,
      source_status: availability === "active" ? "active" : "unknown", proof_status: "customer_selected", is_new_vehicle: false,
      catalog_visible: true, source_updated_at: text(freshness.source_updated_at),
      last_seen_at: text(freshness.last_seen_at), verified_at: text(freshness.last_successful_source_check_at),
      source_payload: {
        import_policy: "explicit_customer_allowlist", model_group: modelGroup, transport_class: vehicleClass,
        availability_at_import: availability,
        presentation_normalization: {
          version: "mobile-de-de-ru/2026-11-09.1",
          original_values: {
            fuel_type: fuel,
            transmission: text(item.transmission),
            drive: text(nested(item, "drive").code ?? item.drive),
            body_type: text(nested(item, "body").code ?? item.body_type ?? item.body),
            color: text(item.color ?? item.color_ru),
            options: item.options ?? [],
          },
        },
      },
    },
    images: [...new Map(images.map((image) => [`${image.position}:${image.source_url}`, image])).values()],
  };
}

const cacheDirectory = resolve(".local/mobile-de-import-cache");
await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
let existingCohortRows = 0;
if (isCustomerCohort) {
  const existingMasterIds = new Set<string>();
  for (let start = 0; start < requestedIds.length; start += 100) {
    const chunk = requestedIds.slice(start, start + 100);
    const { data, error } = await supabase.from("mobile_de_catalog_listings").select("master_id,customer_cohort").in("master_id", chunk);
    if (error) throw new Error(`Could not protect existing Europe rows before import: ${error.message}`);
    for (const row of data ?? []) {
      if (row.customer_cohort !== "customer_europe_2026") throw new Error(`Refusing to overwrite legacy Europe listing ${row.master_id}`);
      existingMasterIds.add(row.master_id);
    }
  }
  const requestedSourceIds = requestedIds.map((id) => String(cohortById.get(id)?.source_id));
  for (let start = 0; start < requestedSourceIds.length; start += 100) {
    const chunk = requestedSourceIds.slice(start, start + 100);
    const { data, error } = await supabase.from("mobile_de_catalog_listings").select("master_id,source_id,customer_cohort").in("source_id", chunk);
    if (error) throw new Error(`Could not protect existing Europe source IDs before import: ${error.message}`);
    for (const row of data ?? []) {
      if (row.customer_cohort !== "customer_europe_2026" || customerSourceToMaster.get(row.source_id) !== row.master_id) {
        throw new Error(`Refusing to overwrite existing Europe source listing ${row.source_id}`);
      }
    }
  }
  existingCohortRows = existingMasterIds.size;
}
let cacheHits = 0;
let checkedCount = 0;
let nextIndex = 0;
const results: Array<{ id: string; mapped: ReturnType<typeof eligible> | null; reason: string | null }> = new Array(requestedIds.length);
if (isCustomerCohort) {
  const missingIds = requestedIds.filter((id) => !existsSync(resolve(cacheDirectory, `customer-${id}.json`)));
  for (let start = 0; start < missingIds.length; start += 100) {
    const chunk = missingIds.slice(start, start + 100);
    const response = record(await getJson(`/customer-cohort/listings?master_ids=${encodeURIComponent(chunk.join(","))}`));
    const items = Array.isArray(response.data) ? response.data.map(record) : [];
    const byMasterId = new Map(items.map((item) => [text(item.master_id), item]));
    if (items.length !== chunk.length || chunk.some((id) => !byMasterId.has(id))) {
      throw new Error(`Master API cohort batch did not return the exact requested ID set (${start + items.length}/${missingIds.length})`);
    }
    for (const id of chunk) {
      await writeFile(resolve(cacheDirectory, `customer-${id}.json`), JSON.stringify({ api_version: response.api_version, data: byMasterId.get(id) }), { mode: 0o600 });
    }
  }
}
async function checkListing(index: number) {
  const id = requestedIds[index];
  const cacheFile = resolve(cacheDirectory, `${isCustomerCohort ? "customer-" : "legacy-"}${id}.json`);
  const endpoint = isCustomerCohort ? `/customer-cohort/listings/${encodeURIComponent(id)}` : `/listings/${encodeURIComponent(id)}`;
  let payload: unknown;
  if (existsSync(cacheFile)) {
    try {
      payload = JSON.parse(await readFile(cacheFile, "utf8")) as unknown;
      cacheHits++;
    } catch {
      payload = await getJson(endpoint);
      await writeFile(cacheFile, JSON.stringify(payload), { mode: 0o600 });
    }
  } else {
    payload = await getJson(endpoint);
    await writeFile(cacheFile, JSON.stringify(payload), { mode: 0o600 });
  }
  const payloadRecord = record(payload);
  const item = record(payloadRecord.data ?? payloadRecord);
  const mapped = isCustomerCohort
    ? eligibleCustomerCohort(item, cohortById.get(id)!) as ReturnType<typeof eligible> | null
    : eligible(item, allowlistedMasterIds);
  if (!mapped) {
    const price = nested(item, "price");
    const category = text(price.category ?? price.evaluation ?? item.price_category ?? item.price_evaluation ?? item.price_rating);
    results[index] = { id, mapped: null, reason: isCustomerCohort ? "Failed explicit cohort class, registration, mileage, price, source ID, or photo check" : category && !priceCategories.has(category) ? "Explicit price category is outside the allowed low/mid set" : "Failed active status, registration, power, mileage, or required-field check" };
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

const summary = { mode: write ? "write" : "dry-run", cohort: isCustomerCohort ? "customer_europe_2026" : "legacy_proven", allowlisted: requestedIds.length, existingCohortRows, fetched: requestedIds.length, accepted: batch.length, skippedCount: skipped.length, skippedSample: skipped.slice(0, 10), photoRows: batch.reduce((sum, row) => sum + row.images.length, 0), masterIds: batch.map(({ listing }) => listing.master_id) };
if (!write) { console.log(JSON.stringify(summary, null, 2)); process.exit(0); }
if ((isCustomerCohort ? limit === 3_860 : limit === 7_333) && skipped.length) throw new Error(`Full import stopped before writing: ${skipped.length} allow-listed records failed strict eligibility`);
if (isCustomerCohort && (limit !== 3_860 || args.get("confirm") !== "mobile-de-customer-cohort-3860")) throw new Error("The customer cohort can only be written as one complete 3,860-ID import with --confirm=mobile-de-customer-cohort-3860");
if (!isCustomerCohort && args.get("confirm") !== "mobile-de-test-import" && limit <= 100) throw new Error("Writing the test batch requires --confirm=mobile-de-test-import");
if (!isCustomerCohort && limit > 100 && args.get("confirm") !== "mobile-de-full-import-7333") throw new Error("Writing all selected listings requires --confirm=mobile-de-full-import-7333");

const { data: run, error: runError } = await supabase.from("mobile_de_catalog_import_runs").insert({ status: "running", source_candidate_count: requestedIds.length, fetched_count: requestedIds.length, proven_count: batch.length, rejected_count: skipped.length }).select("id").single();
if (runError || !run) throw new Error(`Could not create import log: ${runError?.message}`);
try {
  for (let i = 0; i < batch.length; i += 100) {
    const chunk = batch.slice(i, i + 100);
    const { error } = await supabase.from("mobile_de_catalog_listings").upsert(chunk.map((row) => row.listing), { onConflict: "master_id" });
    if (error) throw new Error(`Listing upsert failed: ${error.message}`);
    const images = chunk.flatMap((row) => row.images);
    for (let j = 0; j < images.length; j += 500) {
      const { error: imageError } = await supabase.from("mobile_de_catalog_images").upsert(images.slice(j, j + 500), { onConflict: "master_id,position" });
      if (imageError) throw new Error(`Gallery upsert failed: ${imageError.message}`);
    }
    const { error: progressError } = await supabase.from("mobile_de_catalog_import_runs").update({ upserted_count: Math.min(i + chunk.length, batch.length) }).eq("id", run.id);
    if (progressError) throw new Error(`Could not update import progress: ${progressError.message}`);
  }
  const { error } = await supabase.from("mobile_de_catalog_import_runs").update({ status: "completed", upserted_count: batch.length, finished_at: new Date().toISOString() }).eq("id", run.id);
  if (error) throw new Error(`Could not complete import log: ${error.message}`);
} catch (error) {
  await supabase.from("mobile_de_catalog_import_runs").update({ status: "failed", error_summary: [{ message: error instanceof Error ? error.message : "Unknown import error" }], finished_at: new Date().toISOString() }).eq("id", run.id);
  throw error;
}
console.log(JSON.stringify({ ...summary, runId: run.id, upserted: batch.length }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Unknown import error");
  process.exitCode = 1;
});
