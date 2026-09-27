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

const limit = integerArgument("limit", 100, 1, 2_000);
const offset = integerArgument("offset", 0, 0, 100_000);
const delayMs = integerArgument("delay-ms", 750, 500, 30_000);
const apply = process.argv.includes("--apply");
const summaryOnly = process.argv.includes("--summary-only");
const concurrency = integerArgument("concurrency", 4, 1, 6);

if (process.env.ENCAR_PROXY_URL?.trim()) {
  throw new Error("ENCAR_PROXY_URL is set; refusing to run because this audit must be direct/local");
}

async function main() {
  const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: vehicles, error } = await db
    .from("vehicles")
    .select("source_listing_id")
    .eq("status", "removed")
    .order("source_listing_id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`Failed to load removed vehicles: ${error.message}`);

  const ids = (vehicles ?? []).map((vehicle) => String(vehicle.source_listing_id)).filter(Boolean);
  const results: Array<{ id: string; classification: string; httpStatus?: number; marker?: boolean; error?: string }> = [];

  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      const id = ids[index];
      if (!id) return;
      try {
        const response = await fetch(`https://fem.encar.com/cars/detail/${encodeURIComponent(id)}`, {
          headers: { accept: "text/html,application/xhtml+xml" },
          signal: AbortSignal.timeout(15_000),
        });
        const html = await response.text();
        const deletedMarker = DELETED_MARKERS.some((marker) => html.includes(marker));
        const classification = deletedMarker ? "confirmed-deleted" : response.ok ? "not-confirmed-deleted" : "request-failed";
        results.push({ id, classification, httpStatus: response.status, marker: deletedMarker });
      } catch (error) {
        results.push({ id, classification: "request-failed", error: error instanceof Error ? error.message : String(error) });
      }
      if (nextIndex < ids.length) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));

  const count = (classification: string) => results.filter((result) => result.classification === classification).length;
  const confirmedDeletedIds = results
    .filter((result) => result.classification === "confirmed-deleted")
    .map((result) => result.id);
  let deactivated = 0;
  if (apply && confirmedDeletedIds.length) {
    const { data: updated, error: updateError } = await db
      .from("vehicles")
      .update({ status: "removed", is_public: false })
      .in("source_listing_id", confirmedDeletedIds)
      .select("source_listing_id");
    if (updateError) throw new Error(`Failed to deactivate confirmed deleted vehicles: ${updateError.message}`);
    deactivated = updated?.length ?? 0;
  }
  console.log(JSON.stringify({
    status: "completed",
    dryRun: !apply,
    writes: apply ? deactivated : 0,
    directLocal: true,
    concurrency,
    offset,
    requested: ids.length,
    confirmedDeleted: count("confirmed-deleted"),
    notConfirmedDeleted: count("not-confirmed-deleted"),
    requestFailed: count("request-failed"),
    deactivated,
  }));
  if (!summaryOnly) {
    for (const result of results) console.log(JSON.stringify(result));
  } else {
    for (const result of results.filter((item) => item.classification === "not-confirmed-deleted")) {
      console.log(`https://fem.encar.com/cars/detail/${result.id}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
