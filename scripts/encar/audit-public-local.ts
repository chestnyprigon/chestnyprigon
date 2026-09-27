import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const DELETED_MARKERS = [
  "이 차량은 판매되었거나 삭제된 차량입니다.",
  "이 차량은 판매되었거나 삭제된 차량입니다",
];

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

const limit = integerArgument("limit", 1_000, 1, 1_000);
const concurrency = integerArgument("concurrency", 3, 1, 4);
const delayMs = integerArgument("delay-ms", 1_000, 500, 30_000);
const apply = process.argv.includes("--apply");

if (process.env.ENCAR_PROXY_URL?.trim()) {
  throw new Error("ENCAR_PROXY_URL is set; refusing to run this direct local audit");
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: vehicles, error } = await db
    .from("vehicles")
    .select("source_listing_id")
    .eq("status", "active")
    .eq("is_public", true)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .order("source_listing_id", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Failed to load public vehicles: ${error.message}`);

  const ids = (vehicles ?? []).map((vehicle) => String(vehicle.source_listing_id)).filter(Boolean);
  const checkedAt = new Date().toISOString();
  const found: string[] = [];
  const deleted: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  let next = 0;

  async function worker() {
    while (true) {
      const id = ids[next++];
      if (!id) return;
      try {
        const response = await fetch(`https://fem.encar.com/cars/detail/${encodeURIComponent(id)}`, {
          headers: { accept: "text/html,application/xhtml+xml" },
          signal: AbortSignal.timeout(15_000),
        });
        const html = await response.text();
        const hasDeletedMarker = DELETED_MARKERS.some((marker) => html.includes(marker));
        if (hasDeletedMarker) deleted.push(id);
        else if (response.ok) found.push(id);
        else failed.push({ id, error: `HTTP ${response.status} without confirmed deleted marker` });
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : String(error) });
      }
      await sleep(delayMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));

  let archived = 0;
  if (apply && (found.length || deleted.length)) {
    if (found.length) {
      const { error: foundError } = await db
        .from("vehicles")
        .update({ last_checked_at: checkedAt, revalidation_miss_count: 0 })
        .in("source_listing_id", found);
      if (foundError) throw new Error(`Failed to mark found vehicles: ${foundError.message}`);
      const { error: rawError } = await db
        .from("encar_raw_listings")
        .update({ last_seen_at: checkedAt })
        .in("source_listing_id", found);
      if (rawError) throw new Error(`Failed to update raw listing timestamps: ${rawError.message}`);
    }
    if (deleted.length) {
      const { data, error: deletedError } = await db
        .from("vehicles")
        .update({ status: "removed", is_public: false, last_checked_at: checkedAt, revalidation_miss_count: 0 })
        .in("source_listing_id", deleted)
        .select("source_listing_id");
      if (deletedError) throw new Error(`Failed to archive confirmed deleted vehicles: ${deletedError.message}`);
      archived = data?.length ?? 0;
    }
  }

  console.log(JSON.stringify({
    status: "completed",
    directLocal: true,
    dryRun: !apply,
    requested: ids.length,
    found: found.length,
    confirmedDeleted: deleted.length,
    archived,
    requestFailed: failed.length,
    markedChecked: apply ? found.length + archived : 0,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
