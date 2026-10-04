import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { calculateBelarusPrice, FALLBACK_EXCHANGE_RATES } from "../../src/lib/pricing/chestny-prigon-profile";
import { fetchNbrbRates } from "../../src/lib/pricing/nbrb-rates";
import { loadPersistedPricingProfile } from "./load-profile";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

function requireEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

async function main() {
  const publish = process.argv.includes("--publish");
  const dryRun = process.argv.includes("--dry-run");
  const client = createClient(
    requireEnvironment("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const profile = await loadPersistedPricingProfile(client);
  const exchangeRates = await fetchNbrbRates().catch(() => FALLBACK_EXCHANGE_RATES);
  const vehicles: Array<{
    id: string;
    price_krw: number;
    price_usd: number | null;
    krw_per_usd: number | null;
    engine_cc: number | null;
    first_registration_date: string | null;
    fuel_type: string;
    status: string;
  }> = [];
  const pageSize = 1_000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client
      .from("vehicles")
      .select("id,price_krw,price_usd,krw_per_usd,engine_cc,first_registration_date,fuel_type,status")
      .eq("status", "active")
      .eq("is_public", true)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    vehicles.push(...(data ?? []));
    if ((data?.length ?? 0) < pageSize) break;
  }

  const updates: Array<{ id: string; calculation: ReturnType<typeof calculateBelarusPrice> }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const vehicle of vehicles) {
    try {
      updates.push({
        id: vehicle.id,
        calculation: calculateBelarusPrice({
          priceKrw: Number(vehicle.price_krw),
          engineCc: vehicle.engine_cc,
          firstRegistrationDate: vehicle.first_registration_date,
          fuelType: vehicle.fuel_type,
          preferential: true,
          profile,
          exchangeRates,
        }),
      });
    } catch (error) {
      skipped.push({ id: vehicle.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const storedVehicles = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const writes = [
    ...updates.map(({ id, calculation }) => ({ id, priceUsd: calculation.totalUsd, makePublic: publish })),
    ...skipped.map(({ id }) => ({ id, priceUsd: null, makePublic: false })),
  ].filter(({ id, priceUsd }) => {
    const stored = storedVehicles.get(id)!;
    const storedPrice = stored.price_usd === null ? null : Number(stored.price_usd);
    const storedRate = stored.krw_per_usd === null ? null : Number(stored.krw_per_usd);
    // Compare the actual persisted fields after calculating every vehicle.
    // Changes in rates, inputs, profile or vehicle age still trigger a write.
    return storedPrice !== priceUsd || storedRate !== profile.krwPerUsd;
  });

  for (let offset = 0; !dryRun && offset < writes.length; offset += 10) {
    await Promise.all(
      writes.slice(offset, offset + 10).map(async ({ id, priceUsd, makePublic }) => {
        const { error: updateError } = await client
          .from("vehicles")
          .update({
            price_usd: priceUsd,
            krw_per_usd: profile.krwPerUsd,
            ...(makePublic ? { is_public: true } : {}),
          })
          .eq("id", id);
        if (updateError) throw new Error(`${id}: ${updateError.message}`);
      }),
    );
  }

  console.log({
    profile: profile.version,
    krwPerUsd: profile.krwPerUsd,
    rates: exchangeRates,
    recalculated: updates.length,
    dryRun,
    wouldUpdate: writes.length,
    updated: dryRun ? 0 : writes.length,
    unchanged: vehicles.length - writes.length,
    skipped: skipped.length,
    skippedReasons: [...new Set(skipped.map((item) => item.reason))],
    published: publish && !dryRun,
    minTotalUsd: updates.length ? Math.min(...updates.map((item) => item.calculation.totalUsd ?? Number.POSITIVE_INFINITY)) : null,
    maxTotalUsd: updates.length ? Math.max(...updates.map((item) => item.calculation.totalUsd ?? 0)) : null,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
