import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { calculateBelarusPrice } from "../../src/lib/pricing/chestny-prigon-profile";
import { fetchNbrbRates } from "../../src/lib/pricing/nbrb-rates";
import { fetchPublicDetail } from "./client";
import { loadPersistedPricingProfile } from "../pricing/load-profile";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

type RecordValue = Record<string, unknown>;
type Vehicle = {
  id: string;
  source_listing_id: string;
  price_krw: number;
  price_usd: number | null;
  engine_cc: number | null;
  first_registration_date: string | null;
  fuel_type: string;
  source_updated_at: string | null;
  last_seen_at: string | null;
};

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function integerArgument(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function asRecord(value: unknown): RecordValue {
  return value && typeof value === "object" ? value as RecordValue : {};
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function sourcePriceKrw(detail: unknown) {
  const price = positiveInteger(asRecord(asRecord(detail).advertisement).price);
  return price === null ? null : price * 10_000;
}

async function main() {
  if (process.env.ENCAR_PROXY_URL) throw new Error("ENCAR_PROXY_URL is set; refusing to run through a proxy");
  const limit = integerArgument("limit", 500, 1, 5_000);
  const offset = integerArgument("offset", 0, 0, 100_000);
  const dryRun = process.argv.includes("--dry-run");
  const publicOnly = !process.argv.includes("--all-active");
  const delayMs = integerArgument("delay-ms", 1_500, 0, 60_000);
  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const profile = await loadPersistedPricingProfile(client);

  let query = client
    .from("vehicles")
    .select("id,source_listing_id,price_krw,price_usd,engine_cc,first_registration_date,fuel_type,source_updated_at,last_seen_at")
    .eq("status", "active");
  if (publicOnly) query = query.eq("is_public", true);
  const sourceIds = process.argv.find((argument) => argument.startsWith("--source-ids="))
    ?.slice("--source-ids=".length)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (sourceIds?.length) query = query.in("source_listing_id", sourceIds);
  const { data, error } = await query
    .order("last_seen_at", { ascending: true, nullsFirst: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);
  const vehicles = (data ?? []) as Vehicle[];
  if (!vehicles.length) {
    console.log(JSON.stringify({ status: "completed", dryRun, checked: 0, changed: 0, unchanged: 0, failed: 0 }));
    return;
  }

  const rates = await fetchNbrbRates();
  const checkedAt = new Date().toISOString();
  const changes: Array<RecordValue> = [];
  const rawUpdates: Array<{ source_listing_id: string; payload: RecordValue; last_seen_at: string }> = [];
  let changed = 0;
  let unchanged = 0;
  let failed = 0;

  for (const vehicle of vehicles) {
    try {
      const detail = await fetchPublicDetail(vehicle.source_listing_id, { attempts: 3, timeoutMs: 15_000 });
      const currentPriceKrw = sourcePriceKrw(detail);
      const currentSourceUpdatedAt = asRecord(asRecord(detail).manage).modifyDateTime;
      const sourceUpdatedAt = typeof currentSourceUpdatedAt === "string" && currentSourceUpdatedAt.trim()
        ? currentSourceUpdatedAt
        : vehicle.source_updated_at;
      if (currentPriceKrw === null) throw new Error("Encar detail has no valid advertisement price");
      const calculation = calculateBelarusPrice({
        priceKrw: currentPriceKrw,
        engineCc: vehicle.engine_cc,
        firstRegistrationDate: vehicle.first_registration_date,
        fuelType: vehicle.fuel_type,
        preferential: true,
        profile,
        exchangeRates: rates,
      });
      const priceChanged = currentPriceKrw !== vehicle.price_krw;
      if (priceChanged) {
        changed += 1;
        changes.push({
          vehicle_id: vehicle.id,
          source_listing_id: vehicle.source_listing_id,
          old_price_krw: vehicle.price_krw,
          new_price_krw: currentPriceKrw,
          source_updated_at: sourceUpdatedAt,
        });
        console.log(`${vehicle.source_listing_id}: ${vehicle.price_krw} -> ${currentPriceKrw} KRW`);
      } else {
        unchanged += 1;
      }

      if (!dryRun) {
        const { data: raw, error: rawError } = await client
          .from("encar_raw_listings")
          .select("payload")
          .eq("source_listing_id", vehicle.source_listing_id)
          .single();
        if (rawError) throw new Error(rawError.message);
        const payload = asRecord(raw.payload);
        const search = { ...asRecord(payload.search), Price: currentPriceKrw / 10_000 };
        const mergedDetail = { ...asRecord(payload.detail), ...detail };
        rawUpdates.push({ source_listing_id: vehicle.source_listing_id, payload: { ...payload, search, detail: mergedDetail }, last_seen_at: checkedAt });
        const { error: vehicleError } = await client
          .from("vehicles")
          .update({
            price_krw: currentPriceKrw,
            price_usd: calculation.totalUsd,
            krw_per_usd: profile.krwPerUsd,
            source_updated_at: sourceUpdatedAt,
            last_seen_at: checkedAt,
          })
          .eq("id", vehicle.id);
        if (vehicleError) throw new Error(vehicleError.message);
      }
    } catch (error) {
      failed += 1;
      console.error(`${vehicle.source_listing_id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (delayMs > 0 && vehicle !== vehicles[vehicles.length - 1]) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (!dryRun) {
    for (const update of rawUpdates) {
      const { error: rawError } = await client
        .from("encar_raw_listings")
        .update({ payload: update.payload, last_seen_at: update.last_seen_at, processed_at: checkedAt })
        .eq("source_listing_id", update.source_listing_id);
      if (rawError) throw new Error(rawError.message);
    }
    if (changes.length) {
      const { error: changeError } = await client.from("catalog_price_changes").insert(changes);
      if (changeError) throw new Error(changeError.message);
    }
  }

  console.log(JSON.stringify({ status: "completed", dryRun, publicOnly, requested: vehicles.length, checked: changed + unchanged, changed, unchanged, failed, nextOffset: offset + vehicles.length }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
