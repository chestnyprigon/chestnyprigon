import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { screenStaging } from "../encar/staging-gate";

config({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const RUN_ID = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice("--run-id=".length);
const OFFSET_ARG = process.argv.find((arg) => arg.startsWith("--offset="))?.slice("--offset=".length);
const SIZE_ARG = process.argv.find((arg) => arg.startsWith("--size="))?.slice("--size=".length);
const WAVE_NUMBER_ARG = process.argv.find((arg) => arg.startsWith("--wave-number="))?.slice("--wave-number=".length);
const OFFSET = OFFSET_ARG === undefined ? Number.NaN : Number(OFFSET_ARG);
const SIZE = SIZE_ARG === undefined ? Number.NaN : Number(SIZE_ARG);
const WAVE_NUMBER = WAVE_NUMBER_ARG === undefined ? undefined : Number(WAVE_NUMBER_ARG);
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
  const waveScoped = WAVE_NUMBER !== undefined;
  if (waveScoped) {
    if (!Number.isSafeInteger(WAVE_NUMBER) || WAVE_NUMBER! < 1 || OFFSET_ARG !== undefined || SIZE_ARG !== undefined) {
      throw new Error("--wave-number must be a positive integer and cannot be combined with --offset/--size");
    }
  } else if (!Number.isInteger(OFFSET) || OFFSET < 0 || !Number.isInteger(SIZE) || SIZE < 1 || SIZE > 1_000) {
    throw new Error("Use either --wave-number=N or --offset=N --size=N (size 1..1000)");
  }
  const db = createClient(required(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    required(process.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  let offset = OFFSET;
  let size = SIZE;
  let waveId: string | undefined;
  if (waveScoped) {
    const waveResult = await db.from("chestny_enrichment_waves")
      .select("id,wave_number,candidate_count,status")
      .eq("run_id", runId).eq("wave_number", WAVE_NUMBER).maybeSingle();
    if (waveResult.error) throw new Error(`Could not read selected wave: ${waveResult.error.message}`);
    if (!waveResult.data) throw new Error(`Wave ${WAVE_NUMBER} was not found for run ${runId}`);
    if (!["ready", "completed"].includes(waveResult.data.status)) {
      throw new Error(`Wave ${WAVE_NUMBER} is ${waveResult.data.status}; only a fully screened wave can be prepared`);
    }
    waveId = String(waveResult.data.id);
    size = Number(waveResult.data.candidate_count);
    offset = 0;
  }
  const outputPath = path.resolve(OUTPUT ?? (waveScoped
    ? `output/publication-cohort-wave-${WAVE_NUMBER}-${runId}.json`
    : `output/publication-cohort-${offset + 1}-${offset + size}-${runId}.json`));

  const runResult = await db.from("chestny_enrichment_runs").select("id,status,rules").eq("id", runId).single();
  if (runResult.error) throw new Error(`Could not read run: ${runResult.error.message}`);
  if (!["running", "paused", "completed"].includes(runResult.data.status)) {
    throw new Error(`Run status ${runResult.data.status} is not eligible for a publication cohort audit`);
  }

  let queueQuery = db.from("chestny_enrichment_queue")
    .select("id,source_listing_id,status,created_at,wave_position")
    .eq("run_id", runId);
  if (waveId) queueQuery = queueQuery.eq("wave_id", waveId).order("wave_position", { ascending: true });
  else queueQuery = queueQuery.order("created_at", { ascending: true }).order("id", { ascending: true });
  const queueResult = await queueQuery.range(offset, offset + size - 1);
  if (queueResult.error) throw new Error(`Could not read the selected queue cohort: ${queueResult.error.message}`);
  const cohort = queueResult.data ?? [];
  if (cohort.length !== size) throw new Error(`Queue cohort is incomplete: got ${cohort.length}/${size}`);
  const unfinished = cohort.filter((row) => ["queued", "leased"].includes(row.status));
  if (unfinished.length) throw new Error(`Selected range still has ${unfinished.length} queued or leased candidates`);

  const successful = cohort.filter((row) => row.status === "succeeded");
  const failed = cohort.filter((row) => ["failed", "unavailable", "excluded", "cancelled"].includes(row.status));
  const stageRows: Array<Record<string, unknown>> = [];
  for (const group of chunks(successful.map((row) => String(row.source_listing_id)), 25)) {
    const result = await db.from("chestny_catalog_staging")
      .select("source_listing_id,source_url,candidate_snapshot,encar_payload,image_urls,report_status,enrichment_status,updated_at")
      .in("source_listing_id", group);
    if (result.error) throw new Error(`Could not read saved enrichment data: ${result.error.message}`);
    stageRows.push(...(result.data ?? []));
  }

  const previouslyPublished = new Set<string>();
  const attemptedPublicationIds = new Set<string>();
  const imports = await db.from("import_runs").select("cursor")
    .contains("cursor", { runId }).limit(100);
  if (imports.error) throw new Error(`Could not read previous publication batches: ${imports.error.message}`);
  for (const row of imports.data ?? []) {
    const cursor = row.cursor as Record<string, unknown> | null;
    if (cursor?.publish !== true || !Array.isArray(cursor.sourceListingIds)) continue;
    for (const id of cursor.sourceListingIds) attemptedPublicationIds.add(String(id));
  }

  // Failed import batches may contain hidden drafts; an attempted write is
  // not proof of publication.
  for (const group of chunks([...attemptedPublicationIds], 200)) {
    const publicRows = await db.from("vehicles").select("source_listing_id")
      .in("source_listing_id", group).eq("is_public", true);
    if (publicRows.error) throw new Error(`Could not verify prior publications: ${publicRows.error.message}`);
    for (const row of publicRows.data ?? []) previouslyPublished.add(String(row.source_listing_id));
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
  const baselineIds = new Set<string>();
  const catalogLaunchId = runResult.data.rules?.catalogLaunchId;
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
  if (catalogLaunchId) {
    for (const group of chunks(candidateCanonicalIds, 200)) {
      const baseline = await db.from("chestny_catalog_launch_baseline_identifiers")
        .select("source_identifier").eq("launch_id", catalogLaunchId).in("source_identifier", group);
      if (baseline.error) throw new Error(`Could not check launch baseline: ${baseline.error.message}`);
      for (const row of baseline.data ?? []) baselineIds.add(String(row.source_identifier));
    }
  }
  if (baselineIds.size) rejectedReasons.known_before_launch = baselineIds.size;
  if (alreadyCatalogued.size) rejectedReasons.already_in_catalogue = alreadyCatalogued.size;
  const selected = passed.filter((item) => !duplicateCanonicalIds.has(item.canonicalId) && !alreadyCatalogued.has(item.canonicalId) && !baselineIds.has(item.canonicalId));

  const sourceIds = cohort.map((row) => String(row.source_listing_id));
  const manifest = {
    status: "prepared",
    runId,
    ...(waveId ? { waveId, waveNumber: WAVE_NUMBER } : {}),
    cohortSize: size,
    rangeStart: waveScoped ? 1 : offset + 1,
    rangeEnd: waveScoped ? size : offset + size,
    sourceCohortSha256: sha256(sourceIds),
    sourceCandidateCount: size,
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
    range: waveScoped ? `wave ${WAVE_NUMBER}` : `${offset + 1}-${offset + size}`,
    ...(waveId ? { waveId } : {}),
    sourceCandidates: size,
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
