import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local", quiet: true });

const PARENT_RUN_ID = "b2eeb402-7c6d-4677-a5b6-3b3d326fd86b";
const EXPECTED_RETRY_COUNT = 214;
const REQUIRED_SKIPPED_ENDPOINTS = ["inspection", "diagnosis", "insurance"] as const;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env.local`);
  return value;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function hasNoEndpointPayload(value: unknown): boolean {
  return value === null || value === undefined
    || (typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0);
}

function hasOnlyDocumentedSkippedReports(payload: Record<string, unknown>): boolean {
  const states = object(payload.endpointStatus);
  const reports = object(payload.rawReports);
  return REQUIRED_SKIPPED_ENDPOINTS.every((endpoint) => {
    const status = object(states[endpoint]);
    return status.state === "skipped"
      && status.reasonCode === `${endpoint}_not_requested_after_options_isolation`
      && hasNoEndpointPayload(reports[endpoint]);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- worker tables are not in the generated Supabase schema yet.
type Db = ReturnType<typeof createClient<any>>;

async function fetchByIds<T>(db: Db, table: string, select: string, field: string, ids: string[]): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const { data, error } = await db.from(table).select(select).in(field, ids.slice(offset, offset + 100));
    if (error) throw new Error(`${table} lookup failed: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
  }
  return rows;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: parent, error: parentError } = await db.from("chestny_enrichment_runs")
    .select("id,status,candidate_count,rules").eq("id", PARENT_RUN_ID).single();
  if (parentError) throw new Error(parentError.message);
  if (parent.status !== "completed" || parent.candidate_count !== 745 || object(parent.rules).type !== "targeted_report_refresh") {
    throw new Error("Parent refresh run is not the expected completed 745-candidate report refresh");
  }
  const sourceRunId = text(object(parent.rules).sourceRunId);
  if (!sourceRunId) throw new Error("Parent run has no audited sourceRunId");
  const { data: sourceRun, error: sourceError } = await db.from("chestny_enrichment_runs")
    .select("id,status").eq("id", sourceRunId).single();
  if (sourceError) throw new Error(sourceError.message);
  if (sourceRun.status !== "paused") throw new Error(`Original source run must remain paused; got ${sourceRun.status}`);

  const retrySource = `database:${PARENT_RUN_ID}:verified-same-canonical-alias-retry-v1`;
  const { data: existingRetry, error: existingRetryError } = await db.from("chestny_enrichment_runs")
    .select("id,status").eq("source_file", retrySource).maybeSingle();
  if (existingRetryError) throw new Error(existingRetryError.message);
  if (existingRetry) throw new Error(`A retry run already exists (${existingRetry.status}); refusing to create another`);

  const { data: lock, error: lockError } = await db.from("chestny_enrichment_worker_lock")
    .select("run_id,expires_at").eq("lock_name", "chestny-catalog-enrichment").maybeSingle();
  if (lockError) throw new Error(lockError.message);
  if (lock && Date.parse(String(lock.expires_at)) > Date.now()) throw new Error(`Worker lock is still held for run ${lock.run_id}`);

  const { data: parentQueue, error: queueError } = await db.from("chestny_enrichment_queue")
    .select("source_listing_id,status,source_url,candidate_snapshot,result")
    .eq("run_id", PARENT_RUN_ID).eq("status", "failed");
  if (queueError) throw new Error(queueError.message);

  const candidates = (parentQueue ?? []).filter((row) => {
    const issues = Array.isArray(object(row.result).integrityIssues) ? object(row.result).integrityIssues as Array<Record<string, unknown>> : [];
    return issues.length === 1 && issues[0].code === "identity_existing_staging_conflict";
  });
  if (candidates.length !== EXPECTED_RETRY_COUNT) throw new Error(`Expected ${EXPECTED_RETRY_COUNT} verified canonical sibling failures; found ${candidates.length}`);

  const identities = candidates.map((row) => {
    const result = object(row.result);
    const issue = (object(result).integrityIssues as Array<Record<string, unknown>>)[0];
    const expected = object(issue.expected);
    const actual = object(issue.actual);
    const advertisedId = String(row.source_listing_id);
    const canonicalId = text(result.canonicalId);
    const vehicleNo = text(result.vehicleNo);
    if (text(result.advertisedId) !== advertisedId || text(expected.advertisedId) !== advertisedId
      || text(expected.canonicalId) !== canonicalId || text(actual.sourceListingId) !== canonicalId
      || text(actual.advertisedId) !== canonicalId || text(actual.canonicalId) !== canonicalId
      || !canonicalId || !vehicleNo || advertisedId === canonicalId) {
      throw new Error("Failed row no longer matches the audited same-canonical sibling pattern");
    }
    return { row, advertisedId, canonicalId, vehicleNo };
  });
  if (new Set(identities.map((item) => item.canonicalId)).size !== EXPECTED_RETRY_COUNT) {
    throw new Error("Retry cohort contains duplicate canonical IDs");
  }

  const allIds = [...new Set(identities.flatMap((item) => [item.advertisedId, item.canonicalId]))];
  if (allIds.length !== EXPECTED_RETRY_COUNT * 2) throw new Error("Advertised and canonical IDs overlap across this retry cohort");
  const staging = await fetchByIds<{
    source_listing_id: string;
    enrichment_status: string;
    encar_payload: Record<string, unknown> | null;
  }>(db, "chestny_catalog_staging", "source_listing_id,enrichment_status,encar_payload", "source_listing_id", allIds);
  const stagingById = new Map(staging.map((row) => [String(row.source_listing_id), row]));
  if (staging.length !== EXPECTED_RETRY_COUNT * 2) throw new Error("Expected exactly two staging rows per verified vehicle");

  for (const item of identities) {
    const target = stagingById.get(item.advertisedId);
    const sibling = stagingById.get(item.canonicalId);
    const targetPayload = object(target?.encar_payload);
    const siblingPayload = object(sibling?.encar_payload);
    const targetIdentifiers = object(targetPayload.identifiers);
    const siblingIdentifiers = object(siblingPayload.identifiers);
    const targetDetail = object(targetPayload.detail);
    const siblingDetail = object(siblingPayload.detail);
    if (target?.enrichment_status !== "succeeded" || sibling?.enrichment_status !== "succeeded"
      || text(targetPayload.runId) !== sourceRunId || text(siblingPayload.runId) !== sourceRunId
      || text(targetIdentifiers.advertisedId) !== item.advertisedId
      || text(targetIdentifiers.canonicalId) !== item.canonicalId
      || text(targetIdentifiers.vehicleNo) !== item.vehicleNo
      || text(targetDetail.vehicleId) !== item.canonicalId || text(targetDetail.vehicleNo) !== item.vehicleNo
      || text(siblingIdentifiers.advertisedId) !== item.canonicalId
      || text(siblingIdentifiers.canonicalId) !== item.canonicalId
      || text(siblingIdentifiers.vehicleNo) !== item.vehicleNo
      || text(siblingDetail.vehicleId) !== item.canonicalId || text(siblingDetail.vehicleNo) !== item.vehicleNo
      || !hasOnlyDocumentedSkippedReports(targetPayload) || !hasOnlyDocumentedSkippedReports(siblingPayload)) {
      throw new Error("Staging identity or report state changed; retry was not prepared");
    }
  }

  const vehicleNumbers = [...new Set(identities.map((item) => item.vehicleNo))];
  const [vehicles, identifierLinks] = await Promise.all([
    fetchByIds<{ id: string; source_listing_id: string }>(db, "vehicles", "id,source_listing_id", "source_listing_id", allIds),
    fetchByIds<{ source_identifier: string; vehicle_id: string }>(db, "vehicle_source_identifiers", "source_identifier,vehicle_id", "source_identifier", [...allIds, ...vehicleNumbers]),
  ]);
  if (vehicles.length || identifierLinks.length) throw new Error("Catalog or source-identifier link appeared; retry was not prepared");

  const runId = randomUUID();
  if (!apply) {
    console.log(JSON.stringify({
      status: "dry_run_ready",
      proposedRunId: runId,
      parentRunId: PARENT_RUN_ID,
      sourceRunId,
      queued: candidates.length,
      identityVerified: true,
      catalogLinks: 0,
      publication: "disabled",
      requestMode: "direct targeted refresh; no search",
      requestDelayMs: 2_000,
      globalWorkerLockChecked: true,
      applyRequired: true,
    }, null, 2));
    return;
  }

  const { error: insertRunError } = await db.from("chestny_enrichment_runs").insert({
    id: runId,
    project: "chestny-prigon",
    status: "awaiting_approval",
    candidate_count: candidates.length,
    source_file: retrySource,
    rules: {
      type: "targeted_report_refresh",
      sourceRunId,
      retryParentRunId: PARENT_RUN_ID,
      targetCount: candidates.length,
      endpoints: ["detail", "options", "inspection", "diagnosis", "insurance", "history_availability", "history"],
      transport: "direct",
      requestDelayMs: 2_000,
      publication: "disabled",
      allowMatchingStagingRefresh: true,
      allowVerifiedCanonicalSibling: true,
    },
  });
  if (insertRunError) throw new Error(insertRunError.message);

  for (let offset = 0; offset < candidates.length; offset += 50) {
    const batch = candidates.slice(offset, offset + 50).map((row) => ({
      run_id: runId,
      source_listing_id: String(row.source_listing_id),
      source_url: row.source_url,
      candidate_snapshot: row.candidate_snapshot,
      status: "queued",
    }));
    const { error } = await db.from("chestny_enrichment_queue").insert(batch);
    if (error) throw new Error(`Run ${runId} remains awaiting_approval; queue insert failed: ${error.message}`);
  }
  const { count, error: countError } = await db.from("chestny_enrichment_queue")
    .select("id", { count: "exact", head: true }).eq("run_id", runId).eq("status", "queued");
  if (countError) throw new Error(countError.message);
  if (count !== candidates.length) throw new Error(`Run ${runId} remains awaiting_approval; queued count ${count}/${candidates.length}`);
  const { error: approveError } = await db.from("chestny_enrichment_runs")
    .update({ status: "approved" }).eq("id", runId).eq("status", "awaiting_approval");
  if (approveError) throw new Error(`Retry queue is prepared but run ${runId} could not be approved: ${approveError.message}`);

  console.log(JSON.stringify({
    status: "approved",
    runId,
    parentRunId: PARENT_RUN_ID,
    sourceRunId,
    queued: count,
    identityVerified: true,
    catalogLinks: 0,
    publication: "disabled",
    requestMode: "direct targeted refresh; no search",
    requestDelayMs: 2_000,
    globalWorkerLockChecked: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
