import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { normalizeListing } from "./normalize";
import type { EncarBundle } from "./types";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const supabase = createClient(
  required("NEXT_PUBLIC_SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  const [{ data: vehicles, error: vehiclesError }, { data: rawListings, error: rawError }] = await Promise.all([
    supabase.from("vehicles").select("id,source_listing_id,drive_type,exterior_color"),
    supabase.from("encar_raw_listings").select("source_listing_id,payload"),
  ]);
  if (vehiclesError) throw new Error(vehiclesError.message);
  if (rawError) throw new Error(rawError.message);

  const rawBySourceId = new Map((rawListings ?? []).map((item) => [item.source_listing_id, item.payload]));
  let updated = 0;

  for (const vehicle of vehicles ?? []) {
    const payload = rawBySourceId.get(vehicle.source_listing_id);
    if (!payload) continue;
    const normalized = normalizeListing(payload as EncarBundle);
    const changes: { drive_type?: string; exterior_color?: string } = {};
    if (!vehicle.drive_type && normalized.driveType) changes.drive_type = normalized.driveType;
    if (!vehicle.exterior_color && normalized.exteriorColor) changes.exterior_color = normalized.exteriorColor;
    if (!Object.keys(changes).length) continue;

    const { error } = await supabase.from("vehicles").update(changes).eq("id", vehicle.id);
    if (error) throw new Error(error.message);
    updated += 1;
  }

  process.stdout.write(`Completed: corrected specifications for ${updated} vehicles from saved Encar payloads.\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
