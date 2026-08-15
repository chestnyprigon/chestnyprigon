import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { calculateBelarusPrice, EMAVTO_PRELIMINARY_PROFILE } from "../../src/lib/pricing/emavto-profile";

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
  const { data: vehicles, error } = await client
    .from("vehicles")
    .select("id,price_krw,engine_cc,first_registration_date,fuel_type,status")
    .eq("status", "active");
  if (error) throw new Error(error.message);

  const updates: Array<{ id: string; calculation: ReturnType<typeof calculateBelarusPrice> }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const vehicle of vehicles ?? []) {
    try {
      updates.push({
        id: vehicle.id,
        calculation: calculateBelarusPrice({
          priceKrw: Number(vehicle.price_krw),
          engineCc: vehicle.engine_cc,
          firstRegistrationDate: vehicle.first_registration_date,
          fuelType: vehicle.fuel_type,
          preferential: true,
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
        .update({ price_usd: null, krw_per_usd: null, is_public: false })
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
            krw_per_usd: EMAVTO_PRELIMINARY_PROFILE.rates.krwPerUsd,
            ...(publish ? { is_public: true } : {}),
          })
          .eq("id", id);
        if (updateError) throw new Error(`${id}: ${updateError.message}`);
      }),
    );
  }

  console.log({
    profile: EMAVTO_PRELIMINARY_PROFILE.version,
    recalculated: updates.length,
    skipped: skipped.length,
    skippedReasons: [...new Set(skipped.map((item) => item.reason))],
    published: publish,
    minTotalUsd: updates.length ? Math.min(...updates.map((item) => item.calculation.totalUsd)) : null,
    maxTotalUsd: updates.length ? Math.max(...updates.map((item) => item.calculation.totalUsd)) : null,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
