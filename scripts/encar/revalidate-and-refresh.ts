import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { calculateBelarusPrice } from "../../src/lib/pricing/chestny-prigon-profile";
import { fetchNbrbRates } from "../../src/lib/pricing/nbrb-rates";
import { delay, fetchPublicDetail } from "./client";
import { loadPersistedPricingProfile } from "../pricing/load-profile";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const BATCH_MAX = 250;
const DELAY_MS = 1_500;

type RecordValue = Record<string, unknown>;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function argument(name: string, fallback: number) {
  const raw = process.argv.find((value) => value.startsWith(`--${name}=`));
  return raw ? Number(raw.slice(name.length + 3)) : fallback;
}

function record(value: unknown): RecordValue {
  return value && typeof value === "object" ? value as RecordValue : {};
}

function sourcePriceKrw(detail: unknown) {
  const value = Number(record(record(detail).advertisement).price);
  return Number.isInteger(value) && value > 0 ? value * 10_000 : null;
}

function isNotFound(error: unknown) {
  return error instanceof Error && /HTTP 404/.test(error.message);
}

async function main() {
  if (process.env.ENCAR_PROXY_URL) throw new Error("ENCAR_PROXY_URL is set; refusing to run through a proxy");
  const batchSize = Math.min(Math.max(argument("batch-size", 250), 1), BATCH_MAX);
  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: vehicles, error } = await client
    .from("vehicles")
    .select("id,source_listing_id,price_krw,engine_cc,first_registration_date,fuel_type,source_updated_at")
    .eq("status", "active")
    .eq("is_public", true)
    .is("last_checked_at", null)
    .order("source_listing_id", { ascending: true })
    .limit(batchSize);
  if (error) throw new Error(error.message);
  if (!vehicles?.length) {
    console.log(JSON.stringify({ status: "completed", requested: 0, message: "No unchecked public active listings" }));
    return;
  }

  const profile = await loadPersistedPricingProfile(client);
  const rates = await fetchNbrbRates();
  const run = await client.from("import_runs").insert({
    mode: "refresh",
    status: "running",
    cursor: { source: "encar-local-revalidation-with-price", requested: vehicles.length, batchSize, delayMs: DELAY_MS },
  }).select("id").single();
  if (run.error) throw new Error(run.error.message);

  const found: string[] = [];
  const missing: string[] = [];
  const failed: Array<{ sourceListingId: string; error: string }> = [];
  const updates: Array<{ id: string; sourceListingId: string; priceKrw: number; priceUsd: number | null; sourceUpdatedAt: string | null }> = [];
  const changes: Array<RecordValue> = [];
  const checkedAt = new Date().toISOString();

  for (const vehicle of vehicles) {
    try {
      const detail = await fetchPublicDetail(vehicle.source_listing_id, { attempts: 1, timeoutMs: 15_000 });
      const priceKrw = sourcePriceKrw(detail);
      if (priceKrw === null) throw new Error("Encar detail has no valid advertisement price");
      const sourceUpdatedAtValue = record(record(detail).manage).modifyDateTime;
      const sourceUpdatedAt = typeof sourceUpdatedAtValue === "string" && sourceUpdatedAtValue.trim()
        ? sourceUpdatedAtValue
        : vehicle.source_updated_at;
      const calculation = calculateBelarusPrice({
        priceKrw,
        engineCc: vehicle.engine_cc,
        firstRegistrationDate: vehicle.first_registration_date,
        fuelType: vehicle.fuel_type,
        preferential: true,
        profile,
        exchangeRates: rates,
      });
      found.push(vehicle.source_listing_id);
      updates.push({ id: vehicle.id, sourceListingId: vehicle.source_listing_id, priceKrw, priceUsd: calculation.totalUsd, sourceUpdatedAt });
      if (priceKrw !== vehicle.price_krw) changes.push({ vehicle_id: vehicle.id, source_listing_id: vehicle.source_listing_id, old_price_krw: vehicle.price_krw, new_price_krw: priceKrw, source_updated_at: sourceUpdatedAt });
    } catch (error) {
      if (isNotFound(error)) missing.push(vehicle.source_listing_id);
      else failed.push({ sourceListingId: vehicle.source_listing_id, error: error instanceof Error ? error.message : String(error) });
    }
    await delay(DELAY_MS);
  }

  const { data: applied, error: applyError } = await client.rpc("apply_catalog_revalidation", {
    p_found_source_listing_ids: found,
    p_missing_source_listing_ids: missing,
    p_checked_at: checkedAt,
    p_archive_after: 3,
  });
  if (applyError) throw new Error(applyError.message);

  for (const update of updates) {
    const { error: vehicleError } = await client.from("vehicles").update({
      price_krw: update.priceKrw,
      price_usd: update.priceUsd,
      krw_per_usd: profile.krwPerUsd,
      source_updated_at: update.sourceUpdatedAt,
      last_seen_at: checkedAt,
    }).eq("id", update.id);
    if (vehicleError) throw new Error(vehicleError.message);
  }
  if (changes.length) {
    const { error: changeError } = await client.from("catalog_price_changes").insert(changes);
    if (changeError) throw new Error(changeError.message);
  }
  const { error: finishError } = await client.from("import_runs").update({
    status: "completed",
    finished_at: new Date().toISOString(),
    fetched_count: vehicles.length,
    accepted_count: found.length,
    rejected_count: missing.length,
    error_count: failed.length,
    error_summary: failed,
    cursor: { source: "encar-local-revalidation-with-price", requested: vehicles.length, foundSourceListingIds: found, missingSourceListingIds: missing, failedSourceListingIds: failed.map((item) => item.sourceListingId), checkedAt, priceChanges: changes.length, applied: applied?.[0] ?? null },
  }).eq("id", run.data.id);
  if (finishError) throw new Error(finishError.message);

  console.log(JSON.stringify({ status: "completed", requested: vehicles.length, found: found.length, confirmedMissing: missing.length, blockedOrFailed: failed.length, priceChanged: changes.length, archived: applied?.[0]?.archived_count ?? 0, checkedAt }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
