import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { screenStaging } from "../encar/staging-gate";

config({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const RUN_ID = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice("--run-id=".length);
const OFFSET = Number(process.argv.find((arg) => arg.startsWith("--offset="))?.slice("--offset=".length));
const SIZE = Number(process.argv.find((arg) => arg.startsWith("--size="))?.slice("--size=".length));
const OUTPUT = process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);

function required(value: string | undefined, name: string) {
  if (!value?.trim()) throw new Error(`Missing ${name}`);
  return value.trim();
}

function sha256(ids: string[]) {
  return createHash("sha256").update(ids.join("\n")).digest("hex");
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) result.push(items.slice(offset, offset + size));
  return result;
}

async function main() {
  const runId = required(RUN_ID, "--run-id");
  if (!Number.isInteger(OFFSET) || OFFSET < 0 || !Number.isInteger(SIZE) || SIZE < 1 || SIZE > 1_000) {
    throw new Error("--offset must be non-negative and --size must be from 1 to 1000");
  }
  const outputPath = path.resolve(OUTPUT ?? `output/publication-cohort-${OFFSET + 1}-${OFFSET + SIZE}-${runId}.json`);
  const db = createClient(required(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    required(process.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });

  const runResult = await db.from("chestny_enrichment_runs").select("id,status").eq("id", runId).single();
  if (runResult.error) throw new Error(`Could not read run: ${runResult.error.message}`);
  if (!["running", "paused", "completed"].includes(runResult.data.status)) {
    throw new Error(`Run status ${runResult.data.status} is not eligible for a publication cohort audit`);
  }

  const queueResult = await db.from("chestny_enrichment_queue")
    .select("id,source_listing_id,status,created_at")
    .eq("run_id", runId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(OFFSET, OFFSET + SIZE - 1);
  if (queueResult.error) throw new Error(`Could not read the selected queue range: ${queueResult.error.message}`);
  const cohort = queueResult.data ?? [];
  if (cohort.length !== SIZE) throw new Error(`Queue range is incomplete: got ${cohort.length}/${SIZE}`);
  const unfinished = cohort.filter((row) => ["queued", "leased"].includes(row.status));
  if (unfinished.length) throw new Error(`Selected range still has ${unfinished.length} queued or leased candidates`);

  const successful = cohort.filter((row) => row.status === "succeeded");
  const failed = cohort.filter((row) => ["failed", "unavailable", "cancelled"].includes(row.status));
  const stageRows: Array<Record<string, unknown>> = [];
  for (const group of chunks(successful.map((row) => String(row.source_listing_id)), 25)) {
    const result = await db.from("chestny_catalog_staging")
      .select("source_listing_id,source_url,candidate_snapshot,encar_payload,image_urls,report_status,enrichment_status,updated_at")
      .in("source_listing_id", group);
    if (result.error) throw new Error(`Could not read saved enrichment data: ${result.error.message}`);
    stageRows.push(...(result.data ?? []));
  }

  const previouslyPublished = new Set<string>();
  const imports = await db.from("import_runs").select("cursor")
    .contains("cursor", { runId }).limit(100);
  if (imports.error) throw new Error(`Could not read previous publication batches: ${imports.error.message}`);
  for (const row of imports.data ?? []) {
    const cursor = row.cursor as Record<string, unknown> | null;
    if (cursor?.publish !== true || !Array.isArray(cursor.sourceListingIds)) continue;
    for (const id of cursor.sourceListingIds) previouslyPublished.add(String(id));
  }

  const byId = new Map(stageRows.map((row) => [String(row.source_listing_id), row]));
  const passed: Array<{ sourceId: string; canonicalId: string }> = [];
  const rejectedReasons: Record<string, number> = {};
  const reportCounts: Record<string, number> = {};
  let alreadyPublishedOverlap = 0;
  for (const queueRow of successful) {
    const id = String(queueRow.source_listing_id);
    const row = byId.get(id);
    let reason: string | null = null;
    if (!row) reason = "staging_row_missing";
    else if (row.enrichment_status !== "succeeded") reason = "enrichment_not_succeeded";
    else if ((row.encar_payload as Record<string, unknown> | null)?.runId !== runId) reason = "run_id_mismatch";
    else if (previouslyPublished.has(id)) {
      alreadyPublishedOverlap += 1;
      reason = "already_published_in_run";
    }
    else {
      const evaluation = screenStaging(row);
      if (evaluation.screening.decision !== "approved") {
        reason = evaluation.screening.reasonCodes.join("+") || evaluation.screening.decision;
      } else {
        const canonicalId = String(evaluation.normalized?.sourceListingId ?? "");
        if (!canonicalId) reason = "canonical_id_missing";
        else {
          passed.push({ sourceId: id, canonicalId });
          const reportState = String(row.report_status ?? "missing");
          reportCounts[reportState] = (reportCounts[reportState] ?? 0) + 1;
        }
      }
    }
    if (reason) rejectedReasons[reason] = (rejectedReasons[reason] ?? 0) + 1;
  }
  if (stageRows.length !== successful.length) rejectedReasons.staging_row_count_mismatch = Math.abs(successful.length - stageRows.length);
  if (rejectedReasons.staging_row_count_mismatch) throw new Error("Staging rows do not match the successful queue rows; no manifest written");

  const duplicateCanonicalIds = new Set<string>();
  const firstSourceByCanonical = new Map<string, string>();
  for (const item of passed) {
    const previous = firstSourceByCanonical.get(item.canonicalId);
    if (previous) {
      duplicateCanonicalIds.add(item.canonicalId);
      rejectedReasons.duplicate_canonical_within_cohort = (rejectedReasons.duplicate_canonical_within_cohort ?? 0) + 1;
    } else firstSourceByCanonical.set(item.canonicalId, item.sourceId);
  }
  const candidateCanonicalIds = [...new Set(passed.map((item) => item.canonicalId))];
  const alreadyCatalogued = new Set<string>();
  for (const group of chunks(candidateCanonicalIds, 200)) {
    const [vehicles, identifiers] = await Promise.all([
      db.from("vehicles").select("source_listing_id").in("source_listing_id", group),
      db.from("vehicle_source_identifiers").select("source_identifier").in("source_identifier", group),
    ]);
    if (vehicles.error) throw new Error(`Could not check catalogue duplicates: ${vehicles.error.message}`);
    if (identifiers.error) throw new Error(`Could not check identity duplicates: ${identifiers.error.message}`);
    for (const row of vehicles.data ?? []) alreadyCatalogued.add(String(row.source_listing_id));
    for (const row of identifiers.data ?? []) alreadyCatalogued.add(String(row.source_identifier));
  }
  if (alreadyCatalogued.size) rejectedReasons.already_in_catalogue = alreadyCatalogued.size;
  const selected = passed.filter((item) => !duplicateCanonicalIds.has(item.canonicalId) && !alreadyCatalogued.has(item.canonicalId));

  const fullRangeIds = cohort.map((row) => String(row.source_listing_id));
  const manifest = {
    status: "prepared",
    runId,
    cohortSize: SIZE,
    rangeStart: OFFSET + 1,
    rangeEnd: OFFSET + SIZE,
    sourceCohortSha256: sha256(fullRangeIds),
    sourceCandidateCount: SIZE,
    successfulEnrichments: successful.length,
    unsuccessfulCandidates: failed.length,
    selectedCount: selected.length,
    selectedSourceIdsSha256: sha256(selected.map((item) => item.sourceId)),
    sourceListingIds: selected.map((item) => item.sourceId),
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    status: "prepared_for_review",
    publicationExecuted: false,
    databaseWritten: false,
    runId,
    range: `${OFFSET + 1}-${OFFSET + SIZE}`,
    sourceCandidates: SIZE,
    successfulEnrichments: successful.length,
    unsuccessfulCandidates: failed.length,
    screeningPassed: passed.length,
    reportStatusesAmongScreeningPassed: reportCounts,
    excludedReasons: rejectedReasons,
    previouslyPublishedInThisRun: previouslyPublished.size,
    alreadyPublishedOverlapExcluded: alreadyPublishedOverlap,
    duplicateOrAlreadyCataloguedExcluded: passed.length - selected.length,
    selectedForPublicationReview: selected.length,
    manifestPath: path.relative(process.cwd(), outputPath),
    sourceCohortSha256: manifest.sourceCohortSha256,
    selectedSourceIdsSha256: manifest.selectedSourceIdsSha256,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
