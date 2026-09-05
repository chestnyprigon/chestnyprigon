import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { refreshStoredKrwUsdRate } from "../../src/lib/pricing/krw-usdt-rate";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

refreshStoredKrwUsdRate(client)
  .then((rate) => {
    console.log(JSON.stringify({
      status: "completed",
      source: rate.source,
      rawKrwPerUsdt: rate.rawKrwPerUsdt,
      adjustmentKrw: rate.adjustmentKrw,
      effectiveKrwPerUsd: rate.effectiveKrwPerUsd,
      sourceAsOf: rate.sourceAsOf,
      fetchedAt: rate.fetchedAt,
    }));
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
