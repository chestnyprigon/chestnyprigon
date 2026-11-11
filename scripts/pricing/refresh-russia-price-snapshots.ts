import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { calculateRussiaVehicleSnapshotFresh, type CatalogVehicle, type PersistedPowerResolution } from "../../src/lib/pricing/russia-vehicle-pricing";
import { compactRussiaPriceSnapshot, type RussiaPriceResult } from "../../src/lib/pricing/russia-pricing";
import { refreshStoredKrwUsdRate, storedKrwUsdRate } from "../../src/lib/pricing/krw-usdt-rate";
import { CHESTNY_PRIGON_PRICING_PROFILE } from "../../src/lib/pricing/chestny-prigon-profile";
import type { Database } from "../../src/lib/supabase/database.types";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

type Source = "korea" | "europe";
type DueSnapshot = { source: Source; listing_id: string; calculation: unknown; power_resolution: unknown; revision: number };
let phase = "startup";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function safeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/\b401\b|\b403\b/.test(message)) return "UPSTREAM_AUTH";
  if (/\b429\b/.test(message)) return "UPSTREAM_RATE_LIMIT";
  if (/timeout|timed out|abort/i.test(message)) return "UPSTREAM_TIMEOUT";
  if (/not configured/i.test(message)) return "UPSTREAM_NOT_CONFIGURED";
  if (/response did not match/i.test(message)) return "UPSTREAM_INVALID_RESPONSE";
  return "CALCULATION_FAILED";
}

async function currentKrwPerUsd(client: ReturnType<typeof createClient<Database>>) {
  const { data, error } = await client.from("pricing_krw_usdt_rates")
    .select("raw_krw_per_usdt,adjustment_krw,effective_krw_per_usd,source_as_of,fetched_at")
    .eq("id", "naver-bithumb-usdt").maybeSingle();
  const stored = !error ? storedKrwUsdRate(data ?? {}) : null;
  if (stored && !stored.stale) return stored.effectiveKrwPerUsd;
  try {
    return (await refreshStoredKrwUsdRate(client)).effectiveKrwPerUsd;
  } catch {
    return stored?.effectiveKrwPerUsd ?? CHESTNY_PRIGON_PRICING_PROFILE.krwPerUsd;
  }
}

function vehicleForKorea(row: Database["public"]["Tables"]["vehicles"]["Row"], krwPerUsd: number): CatalogVehicle {
  return {
    source: "korea", sourceId: row.source_listing_id, brand: row.manufacturer, model: row.model,
    generation: row.generation, trim: row.trim, year: row.model_year,
    firstRegistration: row.first_registration_date, engineCc: row.engine_cc, fuelType: row.fuel_type,
    driveType: row.drive_type, price: Number(row.price_krw), currency: "KRW",
    powerPs: row.engine_power_ps, enginePowerKw: row.engine_power_kw,
    electricPeakKw: row.electric_motor_peak_kw, electric30MinKw: row.electric_30min_kw,
    systemCombinedPowerKw: row.system_combined_power_kw, powerBasis: row.power_basis,
    powerConfidence: row.power_confidence, powerSourceRef: [row.power_source_type, row.power_source_url].filter(Boolean).join(":"),
    krwPerUsd,
  };
}

function vehicleForEurope(row: Database["public"]["Tables"]["mobile_de_catalog_listings"]["Row"]): CatalogVehicle | null {
  const price = positiveNumber(row.price_amount);
  if (!price) return null;
  return {
    source: "europe", sourceId: row.master_id, brand: row.make, model: row.model ?? row.title,
    year: row.production_year ?? row.registration_year, firstRegistration: row.first_registration,
    engineCc: row.engine_cc, fuelType: row.fuel_type, driveType: row.drive,
    price, currency: "EUR", powerPs: positiveNumber(row.power_ps) ?? undefined,
  };
}

async function main() {
  phase = "configuration";
  const batchSize = Math.min(100, Math.max(1, Number(process.env.RUSSIA_PRICE_BATCH_SIZE) || 40));
  const concurrency = Math.min(4, Math.max(1, Number(process.env.RUSSIA_PRICE_CONCURRENCY) || 2));
  const client = createClient<Database>(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const now = new Date();
  phase = "read-queue";
  const { data: dueRows, error: dueError } = await client.from("russia_price_snapshots")
    .select("source,listing_id,calculation,power_resolution,revision")
    .in("status", ["pending", "failed", "stale"])
    .lte("next_refresh_at", now.toISOString())
    .order("next_refresh_at", { ascending: true })
    .order("listing_id", { ascending: true })
    .limit(batchSize);
  if (dueError) throw new Error("Could not read due Russian price snapshots");
  const due = (dueRows ?? []) as DueSnapshot[];
  if (!due.length) {
    console.log(JSON.stringify({ processed: 0, ready: 0, failed: 0, batchSize }));
    return;
  }

  const idsBySource = {
    korea: due.filter((row) => row.source === "korea").map((row) => row.listing_id),
    europe: due.filter((row) => row.source === "europe").map((row) => row.listing_id),
  };
  phase = "read-listings";
  const [koreaResult, europeResult] = await Promise.all([
    idsBySource.korea.length
      ? client.from("vehicles").select("id,source_listing_id,manufacturer,model,generation,trim,model_year,first_registration_date,engine_cc,fuel_type,drive_type,price_krw,engine_power_ps,engine_power_kw,electric_motor_peak_kw,electric_30min_kw,system_combined_power_kw,power_basis,power_confidence,power_source_type,power_source_url,status,is_public").in("id", idsBySource.korea).eq("status", "active").eq("is_public", true)
      : Promise.resolve({ data: [], error: null }),
    idsBySource.europe.length
      ? client.from("mobile_de_catalog_listings").select("master_id,source_id,title,make,model,production_year,first_registration,registration_year,engine_cc,power_ps,price_amount,fuel_type,drive,source_status,proof_status,catalog_visible").in("master_id", idsBySource.europe).eq("source_status", "active").eq("proof_status", "proven_verified").eq("catalog_visible", true)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (koreaResult.error || europeResult.error) throw new Error("Could not load source listings for Russian price refresh");

  const koreaRows = (koreaResult.data ?? []) as Database["public"]["Tables"]["vehicles"]["Row"][];
  const europeRows = (europeResult.data ?? []) as Database["public"]["Tables"]["mobile_de_catalog_listings"]["Row"][];
  const koreaById = new Map(koreaRows.map((row) => [row.id, row]));
  const europeById = new Map(europeRows.map((row) => [row.master_id, row]));
  phase = "load-rates";
  const krwPerUsd = idsBySource.korea.length ? await currentKrwPerUsd(client) : CHESTNY_PRIGON_PRICING_PROFILE.krwPerUsd;
  const readyWrites: Array<{ row: DueSnapshot; calculation: RussiaPriceResult; powerResolution: PersistedPowerResolution }> = [];
  const failures: Array<{ row: DueSnapshot; code: string; hadCalculation: boolean }> = [];
  const inactive: DueSnapshot[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, due.length) }, async () => {
    while (cursor < due.length) {
      const row = due[cursor++]!;
      const sourceRow = row.source === "korea" ? koreaById.get(row.listing_id) : europeById.get(row.listing_id);
      if (!sourceRow) {
        inactive.push(row);
        continue;
      }
      const vehicle = sourceRow
        ? row.source === "korea"
          ? vehicleForKorea(sourceRow as Database["public"]["Tables"]["vehicles"]["Row"], krwPerUsd)
          : vehicleForEurope(sourceRow as Database["public"]["Tables"]["mobile_de_catalog_listings"]["Row"])
        : null;
      if (!vehicle) {
        failures.push({ row, code: "INVALID_LISTING_INPUT", hadCalculation: Boolean(row.calculation) });
        continue;
      }
      try {
        const result = await calculateRussiaVehicleSnapshotFresh(vehicle, row.power_resolution, async (powerResolution) => {
          if (JSON.stringify(powerResolution) === JSON.stringify(row.power_resolution)) return;
          const { error } = await client.from("russia_price_snapshots").update({
            power_resolution: powerResolution as unknown as Database["public"]["Tables"]["russia_price_snapshots"]["Update"]["power_resolution"],
            updated_at: now.toISOString(),
          }).eq("source", row.source).eq("listing_id", row.listing_id).eq("destination", "RU").eq("revision", row.revision);
          if (error) throw new Error("Could not persist resolved vehicle power");
        });
        readyWrites.push({ row, calculation: compactRussiaPriceSnapshot(result.calculation), powerResolution: result.powerResolution });
      } catch (error) {
        failures.push({ row, code: safeErrorCode(error), hadCalculation: Boolean(row.calculation) });
      }
    }
  });
  await Promise.all(workers);

  phase = "save-ready";
  let readyCount = 0;
  for (let offset = 0; offset < readyWrites.length; offset += 10) {
    const writes = await Promise.all(readyWrites.slice(offset, offset + 10).map(async ({ row, calculation, powerResolution }) => {
      const { data, error } = await client.from("russia_price_snapshots").update({
        status: "ready", calculation: calculation as unknown as Database["public"]["Tables"]["russia_price_snapshots"]["Update"]["calculation"],
        power_resolution: powerResolution as unknown as Database["public"]["Tables"]["russia_price_snapshots"]["Update"]["power_resolution"],
        calculated_at: now.toISOString(), last_attempt_at: now.toISOString(),
        next_refresh_at: "9999-12-31T00:00:00.000Z",
        last_error_code: null, updated_at: now.toISOString(),
      }).eq("source", row.source).eq("listing_id", row.listing_id).eq("destination", "RU").eq("revision", row.revision).select("listing_id");
      if (error) throw new Error("Could not store refreshed Russian price snapshot");
      return data?.length ?? 0;
    }));
    readyCount += writes.reduce((sum, count) => sum + count, 0);
  }
  for (const failure of failures) {
    phase = "schedule-retry";
    const { error } = await client.from("russia_price_snapshots").update({
      status: failure.hadCalculation ? "stale" : "failed",
      last_attempt_at: now.toISOString(),
      next_refresh_at: new Date(now.getTime() + (failure.code === "UPSTREAM_RATE_LIMIT" ? 60 : 30) * 60 * 1_000).toISOString(),
      last_error_code: failure.code,
      updated_at: now.toISOString(),
    }).eq("source", failure.row.source).eq("listing_id", failure.row.listing_id).eq("destination", "RU").eq("revision", failure.row.revision);
    if (error) throw new Error("Could not schedule retry for a failed Russian price snapshot");
  }
  for (const row of inactive) {
    phase = "remove-inactive";
    const { error } = await client.from("russia_price_snapshots").delete().eq("source", row.source).eq("listing_id", row.listing_id).eq("destination", "RU").eq("revision", row.revision);
    if (error) throw new Error("Could not remove an inactive Russian price snapshot");
  }

  const errorsByCode = failures.reduce<Record<string, number>>((counts, failure) => {
    counts[failure.code] = (counts[failure.code] ?? 0) + 1;
    return counts;
  }, {});
  console.log(JSON.stringify({ processed: due.length, ready: readyCount, changedDuringCalculation: readyWrites.length - readyCount, staleRetained: failures.filter((failure) => failure.hadCalculation).length, failedWithoutPrice: failures.filter((failure) => !failure.hadCalculation).length, removedInactive: inactive.length, errorsByCode, batchSize, concurrency }));
}

main().catch((error) => {
  const code = safeErrorCode(error);
  console.error(JSON.stringify({ job: "russia-price-snapshot-refresh", status: "failed", phase, errorCode: code }));
  process.exitCode = 1;
});
