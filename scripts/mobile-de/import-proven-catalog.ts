import "dotenv/config";

import { createClient } from "@supabase/supabase-js";

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
const args = new Map(process.argv.slice(2).map((value) => {
  const [key, ...rest] = value.replace(/^--/, "").split("=");
  return [key, rest.join("=")];
}));
const write = args.get("write") === "true";
const limit = Number(args.get("limit") ?? 100);
if (!Number.isInteger(limit) || limit < 1 || limit > 7_333) throw new Error("--limit must be from 1 to 7333");
const allowlistPath = process.env.MOBILE_DE_PROVEN_ALLOWLIST_PATH?.trim();
if (!allowlistPath) throw new Error("MOBILE_DE_PROVEN_ALLOWLIST_PATH must point to the recovery export containing the exact 7,333 PROVEN/VERIFIED active Master IDs");

const fs = await import("node:fs/promises");
const allowlist = JSON.parse(await fs.readFile(allowlistPath, "utf8")) as unknown;
const ids = Array.isArray(allowlist) ? allowlist : allowlist && typeof allowlist === "object" && "master_ids" in allowlist ? (allowlist as { master_ids: unknown }).master_ids : null;
if (!Array.isArray(ids) || ids.length !== 7_333 || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
  throw new Error("Allow-list must contain exactly 7,333 unique Master IDs");
}
const requestedIds = (ids as string[]).slice(0, limit);

const priceCategories = new Set(["Sehr guter Preis", "Guter Preis", "Fairer Preis"]);
const proofAliases = new Set(["proven_verified", "PROVEN / VERIFIED", "PROVEN/VERIFIED", "PROVEN", "VERIFIED"]);

async function getJson(path: string) {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Master API ${response.status} for ${path}`);
  return response.json() as Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function nested(value: unknown, key: string) { return record(record(value)[key]); }
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function number(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function array(value: unknown) { return Array.isArray(value) ? value : []; }
function proofStatus(item: Record<string, unknown>) {
  const proof = text(item.proof_status ?? item.verification_status ?? item.status);
  return proof && proofAliases.has(proof) ? "proven_verified" : null;
}
function eligible(item: Record<string, unknown>) {
  const masterId = text(item.master_id);
  const sourceId = text(item.source_id);
  const make = text(item.make);
  const registration = nested(item, "first_registration");
  const regValue = text(registration.value);
  const precision = text(registration.precision);
  const registrationYear = regValue ? Number(regValue.slice(0, 4)) : null;
  const price = nested(item, "price");
  const priceType = text(price.category ?? price.type);
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
  const verified = proofStatus(item);
  const active = normalizedSourceStatus === "active" || item.active === true || item.is_active === true;

  if (!masterId || !sourceId || !make || !verified || !active || !regValue || !precision || ["unknown", "year", "neuwagen"].includes(precision.toLowerCase()) || !registrationYear || registrationYear < 2022 || registrationYear > 2025 ||
    !priceCategories.has(priceType || "") || !priceAmount || !powerValue || powerValue > 160 || !mileage && mileage !== 0 || mileage > 100_000 || isNewVehicle) return null;
  const title = text(item.title) || [make, text(item.model)].filter(Boolean).join(" ");
  const sourceUrl = text(item.source_url) || `https://suchen.mobile.de/fahrzeuge/details.html?id=${encodeURIComponent(sourceId)}`;
  return {
    listing: {
      master_id: masterId, source_id: sourceId, title, make, model: text(item.model),
      production_year: number(item.production_year), first_registration: regValue,
      first_registration_precision: precision, registration_year: registrationYear,
      mileage_km: mileage, engine_cc: number(item.engine_cc), power_ps: powerValue,
      price_amount: priceAmount, price_currency: text(price.currency) || "EUR", price_category: priceType,
      fuel_type: text(item.fuel_type), transmission: text(item.transmission), drive: text(item.drive),
      body_type: text(item.body_type), color: text(item.color), description: text(item.description),
      options: Array.isArray(item.options) ? item.options : [], source_url: sourceUrl,
      primary_image_url: text(nested(item, "primary_image").url) || images[0]?.source_url || null,
      source_status: "active", proof_status: "proven_verified", is_new_vehicle: false,
      catalog_visible: true, source_updated_at: text(freshness.source_updated_at),
      last_seen_at: text(freshness.last_seen_at), verified_at: text(freshness.last_successful_source_check_at),
      source_payload: {
        proof_status: text(item.proof_status ?? item.verification_status),
        source_status: sourceStatus,
        proof_reference: text(item.proof_reference ?? item.proof_id),
        verified_at: text(freshness.last_successful_source_check_at),
      },
    },
    images: [...new Map(images.map((image) => [`${image.position}:${image.source_url}`, image])).values()],
  };
}

const batch = [];
const skipped: Array<{ id: string; reason: string }> = [];
for (const id of requestedIds) {
  const payload = record(await getJson(`/listings/${encodeURIComponent(id)}`));
  const item = record(payload.data ?? payload);
  const mapped = eligible(item);
  if (!mapped) { skipped.push({ id, reason: "Missing/failed strict active, proof, date, power, mileage, price or required-field check" }); continue; }
  batch.push(mapped);
}

const summary = { mode: write ? "write" : "dry-run", allowlisted: requestedIds.length, fetched: requestedIds.length, accepted: batch.length, skipped, photoRows: batch.reduce((sum, row) => sum + row.images.length, 0), masterIds: batch.map(({ listing }) => listing.master_id) };
if (!write) { console.log(JSON.stringify(summary, null, 2)); process.exit(0); }
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
