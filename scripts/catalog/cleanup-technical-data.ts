import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const retentionDays = Number(process.env.CATALOG_TECHNICAL_RETENTION_DAYS ?? 60);
if (!Number.isInteger(retentionDays) || retentionDays < 30) {
  throw new Error("CATALOG_TECHNICAL_RETENTION_DAYS must be an integer >= 30");
}

const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
const apply = process.argv.includes("--apply");

async function count(client: any, table: string, column: string, filters: string[] = []) {
  let query = client.from(table).select(column, { count: "exact", head: true });
  for (const filter of filters) {
    const [operator, value] = filter.split("=", 2);
    if (operator === "lt") query = query.lt(column, value);
  }
  const { count: total, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
  return total ?? 0;
}

async function main() {
  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (!apply) {
    const [raw, reports, screening, runs] = await Promise.all([
      count(client, "encar_raw_listings", "last_seen_at", [`lt=${cutoff}`]),
      count(client, "vehicle_reports", "updated_at", [`lt=${cutoff}`]),
      count(client, "listing_screening", "screened_at", [`lt=${cutoff}`]),
      count(client, "import_runs", "created_at", [`lt=${cutoff}`]),
    ]);
    console.log(JSON.stringify({ status: "dry-run", cutoff, retentionDays, raw, reports, screening, runs }));
    return;
  }

  const { data, error } = await client.rpc("cleanup_catalog_technical_data", { p_cutoff: cutoff });
  if (error) throw new Error(error.message);
  console.log(JSON.stringify({ status: "completed", cutoff, retentionDays, result: data?.[0] ?? null }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
