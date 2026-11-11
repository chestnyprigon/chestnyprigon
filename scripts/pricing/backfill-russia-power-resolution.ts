import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { powerResolutionFromSavedCalculation, type CatalogVehicle } from "../../src/lib/pricing/russia-vehicle-pricing";
import type { Database } from "../../src/lib/supabase/database.types";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

type Source = "korea" | "europe";
type Snapshot = { source: Source; listing_id: string; calculation: unknown; power_resolution: unknown; revision: number };
const PAGE_SIZE = Math.min(250, Math.max(25, Number(process.env.RUSSIA_POWER_BACKFILL_BATCH_SIZE) || 200));
const CONCURRENCY = Math.min(10, Math.max(1, Number(process.env.RUSSIA_POWER_BACKFILL_CONCURRENCY) || 6));

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function samePower(left: unknown, right: unknown) {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && Object.is(leftRecord[key], rightRecord[key]));
}

async function retryRead<T>(label: string, read: () => PromiseLike<{ data: T | null; error: { code?: string } | null }>) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = await read();
    if (!result.error) return result;
    if (attempt === 4) throw new Error(`${label} failed (${result.error.code ?? "database_error"})`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
  throw new Error(`${label} failed`);
}

function vehicleForKorea(row: Database["public"]["Tables"]["vehicles"]["Row"]): CatalogVehicle {
  return {
    source: "korea", sourceId: row.source_listing_id, brand: row.manufacturer, model: row.model,
    generation: row.generation, trim: row.trim, year: row.model_year,
    firstRegistration: row.first_registration_date, engineCc: row.engine_cc,
    fuelType: row.fuel_type, driveType: row.drive_type,
    price: Number(row.price_krw), currency: "KRW",
    powerPs: row.engine_power_ps, enginePowerKw: row.engine_power_kw,
    electricPeakKw: row.electric_motor_peak_kw, electric30MinKw: row.electric_30min_kw,
    systemCombinedPowerKw: row.system_combined_power_kw, powerBasis: row.power_basis,
    powerConfidence: row.power_confidence,
    powerSourceRef: [row.power_source_type, row.power_source_url].filter(Boolean).join(":"),
  };
}

function vehicleForEurope(row: Database["public"]["Tables"]["mobile_de_catalog_listings"]["Row"]): CatalogVehicle | null {
  const price = Number(row.price_amount);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    source: "europe", sourceId: row.master_id, brand: row.make, model: row.model ?? row.title,
    year: row.production_year ?? row.registration_year, firstRegistration: row.first_registration,
    engineCc: row.engine_cc, fuelType: row.fuel_type, driveType: row.drive,
    price, currency: "EUR", powerPs: row.power_ps,
  };
}

async function processSource(client: ReturnType<typeof createClient<Database>>, source: Source, refreshLegacy: boolean) {
  let lastId = "";
  let scanned = 0;
  let saved = 0;
  let skipped = 0;
  while (true) {
    const { data } = await retryRead(`Read ${source} snapshots`, () => {
      let query = client.from("russia_price_snapshots").select("source,listing_id,calculation,power_resolution,revision")
        .eq("source", source).eq("status", "ready")
        .not("calculation", "is", null).order("listing_id", { ascending: true }).limit(PAGE_SIZE);
      query = refreshLegacy
        ? query.filter("power_resolution->>status", "eq", "legacy_snapshot")
        : query.is("power_resolution", null);
      if (lastId) query = query.gt("listing_id", lastId);
      return query;
    });
    const snapshots = (data ?? []) as Snapshot[];
    if (!snapshots.length) break;
    lastId = snapshots[snapshots.length - 1]!.listing_id;
    scanned += snapshots.length;

    const ids = snapshots.map((snapshot) => snapshot.listing_id);
    let sourceRows: unknown[] | null;
    if (source === "korea") {
      const result = await retryRead(`Read ${source} listings`, () => client.from("vehicles")
        .select("id,source_listing_id,manufacturer,model,generation,trim,model_year,first_registration_date,engine_cc,fuel_type,drive_type,price_krw,engine_power_ps,engine_power_kw,electric_motor_peak_kw,electric_30min_kw,system_combined_power_kw,power_basis,power_confidence,power_source_type,power_source_url")
        .in("id", ids));
      sourceRows = result.data as unknown[] | null;
    } else {
      const result = await retryRead(`Read ${source} listings`, () => client.from("mobile_de_catalog_listings")
        .select("master_id,source_id,title,make,model,production_year,first_registration,registration_year,engine_cc,power_ps,price_amount,fuel_type,drive")
        .in("master_id", ids));
      sourceRows = result.data as unknown[] | null;
    }
    const vehicles = new Map<string, CatalogVehicle>();
    if (source === "korea") {
      for (const row of (sourceRows ?? []) as unknown as Database["public"]["Tables"]["vehicles"]["Row"][]) vehicles.set(row.id, vehicleForKorea(row));
    } else {
      for (const row of (sourceRows ?? []) as unknown as Database["public"]["Tables"]["mobile_de_catalog_listings"]["Row"][]) {
        const vehicle = vehicleForEurope(row);
        if (vehicle) vehicles.set(row.master_id, vehicle);
      }
    }

    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, snapshots.length) }, async () => {
      while (cursor < snapshots.length) {
        const snapshot = snapshots[cursor++]!;
        const vehicle = vehicles.get(snapshot.listing_id);
        const resolution = vehicle ? powerResolutionFromSavedCalculation(vehicle, snapshot.calculation) : null;
        if (!resolution) { skipped += 1; continue; }
        if (refreshLegacy && samePower(resolution.power, (snapshot.power_resolution as { power?: unknown } | null)?.power)) {
          skipped += 1;
          continue;
        }
        const { data: updated, error: updateError } = await client.from("russia_price_snapshots").update({
          power_resolution: resolution as unknown as Database["public"]["Tables"]["russia_price_snapshots"]["Update"]["power_resolution"],
          updated_at: new Date().toISOString(),
        }).eq("source", source).eq("listing_id", snapshot.listing_id).eq("destination", "RU")
          .eq("revision", snapshot.revision)
          .filter("power_resolution->>status", refreshLegacy ? "eq" : "is", refreshLegacy ? "legacy_snapshot" : null)
          .select("listing_id");
        if (updateError) throw new Error(`Could not save power cache for ${source} snapshot`);
        if (updated?.length) saved += 1;
        else skipped += 1;
      }
    });
    await Promise.all(workers);
    console.log(JSON.stringify({ source, scanned, saved, skipped, cursor: lastId }));
  }
  return { source, scanned, saved, skipped };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const refreshLegacy = process.argv.includes("--refresh-legacy");
  const sourceArgument = process.argv.find((argument) => argument.startsWith("--source="))?.slice("--source=".length);
  const sources: Source[] = sourceArgument === "korea" || sourceArgument === "europe"
    ? [sourceArgument]
    : ["korea", "europe"];
  const client = createClient<Database>(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  if (!apply) {
    const summaries = await Promise.all(sources.map(async (source) => {
      let query = client.from("russia_price_snapshots").select("listing_id", { count: "exact", head: true })
        .eq("source", source).eq("status", "ready").not("calculation", "is", null);
      query = refreshLegacy
        ? query.filter("power_resolution->>status", "eq", "legacy_snapshot")
        : query.is("power_resolution", null);
      const { count, error } = await query;
      if (error) throw new Error(`Could not count ${source} snapshots`);
      return { source, eligible: count ?? 0 };
    }));
    console.log(JSON.stringify({ mode: "dry-run", refreshLegacy, externalPowerRequests: 0, summaries }));
    return;
  }
  const summaries: Array<Awaited<ReturnType<typeof processSource>>> = [];
  for (const source of sources) summaries.push(await processSource(client, source, refreshLegacy));
  console.log(JSON.stringify({ mode: "applied", refreshLegacy, externalPowerRequests: 0, summaries }));
}

main().catch((error) => {
  console.error(JSON.stringify({ job: "russia-power-resolution-backfill", status: "failed", error: error instanceof Error ? error.message : "unknown" }));
  process.exitCode = 1;
});
