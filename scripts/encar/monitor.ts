import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { delay, fetchDetail } from "./client";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_DELAY_MS = 1_500;
const DEFAULT_ARCHIVE_AFTER = 3;

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

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function isNotFoundError(error: unknown) {
  return error instanceof Error && /HTTP 404/.test(error.message);
}

async function main() {
  const batchSize = integerArgument("batch-size", Number(process.env.ENCAR_MONITOR_BATCH_SIZE ?? DEFAULT_BATCH_SIZE), 1, 1_000);
  const concurrency = integerArgument("concurrency", Number(process.env.ENCAR_MONITOR_CONCURRENCY ?? DEFAULT_CONCURRENCY), 1, 2);
  const delayMs = integerArgument("delay-ms", Number(process.env.ENCAR_MONITOR_DELAY_MS ?? DEFAULT_DELAY_MS), 500, 30_000);
  const archiveAfter = integerArgument("archive-after", Number(process.env.ENCAR_MONITOR_ARCHIVE_AFTER ?? DEFAULT_ARCHIVE_AFTER), 2, 5);
  const dryRun = hasFlag("dry-run");

  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: candidates, error: candidateError } = await client
    .from("vehicles")
    .select("source_listing_id,last_checked_at,revalidation_miss_count")
    .eq("status", "active")
    .eq("is_public", true)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .order("source_listing_id", { ascending: true })
    .limit(batchSize);
  if (candidateError) throw new Error(candidateError.message);

  const ids = (candidates ?? []).map((vehicle) => String(vehicle.source_listing_id));
  if (!ids.length) {
    console.log({ status: "completed", requested: 0, message: "No public active listings require monitoring" });
    return;
  }

  const startedAt = new Date().toISOString();
  let runId: string | undefined;
  if (!dryRun) {
    const run = await client
      .from("import_runs")
      .insert({
        mode: "refresh",
        status: "running",
        cursor: {
          source: "encar-availability-monitor",
          requested: ids.length,
          batchSize,
          concurrency,
          delayMs,
          archiveAfter,
          dryRun,
          startedAt,
        },
      })
      .select("id")
      .single();
    if (run.error) throw new Error(run.error.message);
    runId = run.data.id;
  }

  const found: string[] = [];
  const missing: string[] = [];
  const failed: Array<{ sourceListingId: string; error: string }> = [];
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      const sourceListingId = ids[index];
      if (!sourceListingId) return;
      try {
        await fetchDetail(sourceListingId, { attempts: 1, timeoutMs: 8_000 });
        found.push(sourceListingId);
      } catch (error) {
        if (isNotFoundError(error)) missing.push(sourceListingId);
        else failed.push({ sourceListingId, error: error instanceof Error ? error.message : String(error) });
      }
      await delay(delayMs);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const checkedAt = new Date().toISOString();
  let applied = { found_count: found.length, missing_count: missing.length, archived_count: 0 };
  if (!dryRun) {
    const { data, error } = await client.rpc("apply_catalog_revalidation", {
      p_found_source_listing_ids: found,
      p_missing_source_listing_ids: missing,
      p_checked_at: checkedAt,
      p_archive_after: archiveAfter,
    });
    if (error) throw new Error(error.message);
    applied = data?.[0] ?? applied;

    if (found.length) {
      const { error: rawError } = await client
        .from("encar_raw_listings")
        .update({ last_seen_at: checkedAt })
        .in("source_listing_id", found);
      if (rawError) throw new Error(rawError.message);
    }
  }

  if (runId) {
    const { error: finishError } = await client
      .from("import_runs")
      .update({
        status: "completed",
        finished_at: new Date().toISOString(),
        fetched_count: ids.length,
        accepted_count: found.length,
        rejected_count: missing.length,
        error_count: failed.length,
        error_summary: failed,
        cursor: {
          source: "encar-availability-monitor",
          requested: ids.length,
          checkedAt,
          foundSourceListingIds: found,
          missingSourceListingIds: missing,
          failedSourceListingIds: failed.map((item) => item.sourceListingId),
          dryRun,
          applied,
          note: "Only confirmed 404 responses count as missing; transient errors never change publication status.",
        },
      })
      .eq("id", runId);
    if (finishError) throw new Error(finishError.message);
  }

  console.log({
    status: "completed",
    dryRun,
    requested: ids.length,
    found: found.length,
    confirmedMissing: missing.length,
    transientErrors: failed.length,
    archived: dryRun ? 0 : applied.archived_count,
    updatedLastSeenAt: dryRun ? 0 : found.length,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
