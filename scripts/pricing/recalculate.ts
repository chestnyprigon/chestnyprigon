import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { calculateBelarusPrice, CHESTNY_PRIGON_PRICING_PROFILE, FALLBACK_EXCHANGE_RATES } from "../../src/lib/pricing/chestny-prigon-profile";
import { fetchNbrbRates } from "../../src/lib/pricing/nbrb-rates";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

function requireEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

async function main() {
  const publish = process.argv.includes("--publish");
  const client = createClient(
    requireEnvironment("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const exchangeRates = await fetchNbrbRates().catch(() => FALLBACK_EXCHANGE_RATES);
  const vehicles: Array<{
    id: string;
    price_krw: number;
    engine_cc: number | null;
    first_registration_date: string | null;
    fuel_type: string;
    status: string;
  }> = [];
  const pageSize = 1_000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client
      .from("vehicles")
      .select("id,price_krw,engine_cc,first_registration_date,fuel_type,status")
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
          exchangeRates,
        }),
      });
    } catch (error) {
      skipped.push({ id: vehicle.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  await Promise.all(
    skipped.map(async ({ id }) => {
      const { error: updateError } = await client
        .from("vehicles")
        .update({ price_usd: null, krw_per_usd: CHESTNY_PRIGON_PRICING_PROFILE.krwPerUsd })
        .eq("id", id);
      if (updateError) throw new Error(`${id}: ${updateError.message}`);
    }),
  );

  for (let offset = 0; offset < updates.length; offset += 10) {
    await Promise.all(
      updates.slice(offset, offset + 10).map(async ({ id, calculation }) => {
        const { error: updateError } = await client
          .from("vehicles")
          .update({
            price_usd: calculation.totalUsd,
            krw_per_usd: CHESTNY_PRIGON_PRICING_PROFILE.krwPerUsd,
            ...(publish ? { is_public: true } : {}),
          })
          .eq("id", id);
        if (updateError) throw new Error(`${id}: ${updateError.message}`);
      }),
    );
  }

  console.log({
    profile: CHESTNY_PRIGON_PRICING_PROFILE.version,
    rates: exchangeRates,
    recalculated: updates.length,
    skipped: skipped.length,
    skippedReasons: [...new Set(skipped.map((item) => item.reason))],
    published: publish,
    minTotalUsd: updates.length ? Math.min(...updates.map((item) => item.calculation.totalUsd ?? Number.POSITIVE_INFINITY)) : null,
    maxTotalUsd: updates.length ? Math.max(...updates.map((item) => item.calculation.totalUsd ?? 0)) : null,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
