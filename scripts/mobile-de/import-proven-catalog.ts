import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const envCandidates = [process.env.DOTENV_CONFIG_PATH, ".env.local", "../../.env.local", ".env"]
  .filter((path): path is string => Boolean(path));
for (const path of envCandidates) if (existsSync(path)) loadEnv({ path });

const API_ROOT = "https://api.koredigital.co.kr/v1/internal/mobile-de";
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
const requestedIds = [...(ids as string[])].sort().slice(0, limit);
const allowlistedMasterIds = new Set(ids as string[]);

const priceCategories = new Set(["Sehr guter Preis", "Guter Preis", "Fairer Preis"]);
const proofAliases = new Set(["proven_verified", "PROVEN / VERIFIED", "PROVEN/VERIFIED"]);

let nextApiRequestAt = 0;
async function getJson(path: string): Promise<unknown> {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const delay = Math.max(0, nextApiRequestAt - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    nextApiRequestAt = Date.now() + 1_050;
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

const batch = [];
const skipped: Array<{ id: string; reason: string }> = [];
const cacheDirectory = resolve(".local/mobile-de-import-cache");
await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
let cacheHits = 0;
for (let index = 0; index < requestedIds.length; index++) {
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
    const category = text(price.category ?? price.evaluation ?? item.price_category ?? item.price_evaluation ?? item.price_rating);
    skipped.push({ id, reason: category && !priceCategories.has(category) ? "Explicit price category is outside the allowed low/mid set" : "Failed active status, registration, power, mileage, or required-field check" });
    continue;
  }
  batch.push(mapped);
  if ((index + 1) % 100 === 0 || index + 1 === requestedIds.length) {
    console.log(`Checked ${index + 1}/${requestedIds.length} listings (${cacheHits} resumed from local cache; ${batch.length} eligible)`);
  }
}

const summary = { mode: write ? "write" : "dry-run", allowlisted: requestedIds.length, fetched: requestedIds.length, accepted: batch.length, skippedCount: skipped.length, skippedSample: skipped.slice(0, 10), photoRows: batch.reduce((sum, row) => sum + row.images.length, 0), masterIds: batch.map(({ listing }) => listing.master_id) };
if (!write) { console.log(JSON.stringify(summary, null, 2)); process.exit(0); }
if (limit === 7_333 && skipped.length) throw new Error(`Full import stopped before writing: ${skipped.length} allow-listed records failed strict eligibility`);
if (args.get("confirm") !== "mobile-de-test-import" && limit <= 100) throw new Error("Writing the test batch requires --confirm=mobile-de-test-import");
if (limit > 100 && args.get("confirm") !== "mobile-de-full-import-7333") throw new Error("Writing all selected listings requires --confirm=mobile-de-full-import-7333");

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
