import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { delay, fetchDetail } from "./client";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const DETAIL_CONCURRENCY = 2;
const DETAIL_DELAY_MS = 800;

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

async function main() {
  const limit = integerArgument("limit", 500, 1, 500);
  const offset = integerArgument("offset", 0, 0, 100_000);
  const retryFailed = hasFlag("retry-failed");
  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: runs, error: runsError } = await client
    .from("import_runs")
    .select("id,created_at,cursor")
    .order("created_at", { ascending: false })
    .limit(100);
  if (runsError) throw new Error(runsError.message);
  const sourceRun = (runs ?? []).find((run) => {
    const cursor = run.cursor as Record<string, unknown>;
    return cursor.source === "encar-revalidation" && Array.isArray(cursor.summary) && cursor.summary.length > 10;
  });
  if (!sourceRun) throw new Error("Full search revalidation run was not found");

  let missingIds = [...new Set(((sourceRun.cursor as Record<string, unknown>).missingSourceListingIds as string[] | undefined) ?? [])];
  if (retryFailed) {
    const { data: detailRuns, error: detailRunsError } = await client
      .from("import_runs")
      .select("cursor")
      .eq("mode", "refresh")
      .order("created_at", { ascending: false })
      .limit(30);
    if (detailRunsError) throw new Error(detailRunsError.message);
    missingIds = [...new Set(
      (detailRuns ?? [])
        .filter((item) => (item.cursor as Record<string, unknown>).source === "encar-detail-revalidation")
        .flatMap((item) => ((item.cursor as Record<string, unknown>).failedSourceListingIds as string[] | undefined) ?? []),
    )];
  }
  const batchIds = missingIds.slice(offset, offset + limit);
  if (!batchIds.length) throw new Error(`No missing listings at offset ${offset}`);

  const run = await client
    .from("import_runs")
    .insert({
      mode: "refresh",
      status: "running",
      cursor: {
        source: "encar-detail-revalidation",
        parentRunId: sourceRun.id,
        offset,
        requested: batchIds.length,
        retryFailed,
      },
    })
    .select("id")
    .single();
  if (run.error) throw new Error(run.error.message);

  const found: string[] = [];
  const failed: Array<{ sourceListingId: string; error: string }> = [];
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      const sourceListingId = batchIds[index];
      if (!sourceListingId) return;
      try {
        await fetchDetail(sourceListingId, retryFailed ? { attempts: 1, timeoutMs: 5_000 } : undefined);
        found.push(sourceListingId);
      } catch (error) {
        failed.push({ sourceListingId, error: error instanceof Error ? error.message : String(error) });
      }
      await delay(DETAIL_DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, () => worker()));

  const checkedAt = new Date().toISOString();
  for (let index = 0; index < found.length; index += 500) {
    const { error } = await client
      .from("vehicles")
      .update({ last_seen_at: checkedAt })
      .in("source_listing_id", found.slice(index, index + 500));
    if (error) throw new Error(error.message);
    const { error: rawError } = await client
      .from("encar_raw_listings")
      .update({ last_seen_at: checkedAt })
      .in("source_listing_id", found.slice(index, index + 500));
    if (rawError) throw new Error(rawError.message);
  }

  const { error: finishError } = await client
    .from("import_runs")
    .update({
      status: "completed",
      finished_at: new Date().toISOString(),
      fetched_count: batchIds.length,
      accepted_count: found.length,
      rejected_count: failed.length,
      error_count: 0,
      cursor: {
        source: "encar-detail-revalidation",
        parentRunId: sourceRun.id,
        offset,
        requested: batchIds.length,
        retryFailed,
        foundSourceListingIds: found,
        failedSourceListingIds: failed.map((item) => item.sourceListingId),
        checkedAt,
        note: "Failed detail requests are reported only; no vehicles were unpublished or deleted.",
      },
    })
    .eq("id", run.data.id);
  if (finishError) throw new Error(finishError.message);

  console.log({
    status: "completed",
    parentRunId: sourceRun.id,
    offset,
    requested: batchIds.length,
    found: found.length,
    failed: failed.length,
    updatedLastSeenAt: found.length,
    nextOffset: offset + batchIds.length,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
