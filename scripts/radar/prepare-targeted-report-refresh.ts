import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { CATALOG_POLICY } from "../encar/catalog-policy";

config({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const SOURCE_RUN_ID = "db2ab5fa-2271-40cb-aec0-d5a77c6608fb";
const EXPECTED_COUNT = 745;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function main() {
  const sourceIdsPath = path.resolve(process.cwd(), process.argv.find((arg) => arg.startsWith("--source-ids-file="))?.split("=").slice(1).join("=") ?? "output/options-empty-745-source-ids.json");
  const sourceDocument = JSON.parse(await fs.readFile(sourceIdsPath, "utf8")) as { sourceRunId?: string; sourceIds?: string[] };
  const sourceIds = sourceDocument.sourceIds ?? [];
  if (sourceDocument.sourceRunId !== SOURCE_RUN_ID || sourceIds.length !== EXPECTED_COUNT
    || sourceIds.some((id) => !/^\d+$/.test(id)) || new Set(sourceIds).size !== EXPECTED_COUNT) {
    throw new Error("Target ID file must contain the audited 745 unique IDs from the expected source run");
  }

  const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: sourceRun, error: sourceRunError } = await db.from("chestny_enrichment_runs")
    .select("id,status").eq("id", SOURCE_RUN_ID).single();
  if (sourceRunError) throw new Error(sourceRunError.message);
  if (sourceRun.status !== "paused") throw new Error(`Source run must remain paused; current status is ${sourceRun.status}`);

  const { data: lock, error: lockError } = await db.from("chestny_enrichment_worker_lock")
    .select("run_id,expires_at").eq("lock_name", "chestny-catalog-enrichment").maybeSingle();
  if (lockError) throw new Error(lockError.message);
  if (lock && Date.parse(String(lock.expires_at)) > Date.now()) throw new Error(`Another worker holds the global lock for run ${lock.run_id}`);

  const queueRows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < sourceIds.length; offset += 200) {
    const { data, error } = await db.from("chestny_enrichment_queue")
      .select("source_listing_id,status,source_url,candidate_snapshot")
      .eq("run_id", SOURCE_RUN_ID).in("source_listing_id", sourceIds.slice(offset, offset + 200));
    if (error) throw new Error(error.message);
    queueRows.push(...(data ?? []));
  }
  if (queueRows.length !== EXPECTED_COUNT || queueRows.some((row) => row.status !== "succeeded")) {
    throw new Error(`Source queue is not the expected succeeded set: ${queueRows.length}/${EXPECTED_COUNT}`);
  }

  const stagingRows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < sourceIds.length; offset += 100) {
    const { data, error } = await db.from("chestny_catalog_staging")
      .select("source_listing_id,enrichment_status,encar_payload")
      .in("source_listing_id", sourceIds.slice(offset, offset + 100));
    if (error) throw new Error(error.message);
    stagingRows.push(...(data ?? []));
  }
  if (stagingRows.length !== EXPECTED_COUNT || stagingRows.some((row) => row.enrichment_status !== "succeeded"
    || object(row.encar_payload).runId !== SOURCE_RUN_ID)) {
    throw new Error(`Target staging does not match the audited source run: ${stagingRows.length}/${EXPECTED_COUNT}`);
  }
  const stageById = new Map(stagingRows.map((row) => [String(row.source_listing_id), row]));
  const identityOwners = new Map<string, string>();
  for (const id of sourceIds) {
    const payload = object(stageById.get(id)?.encar_payload);
    const identifiers = object(payload.identifiers);
    const detail = object(payload.detail);
    const endpoints = object(payload.endpointStatus);
    if (String(identifiers.advertisedId ?? "") !== id || !identifiers.canonicalId || !identifiers.vehicleNo
      || String(detail.vehicleId ?? "") !== String(identifiers.canonicalId)) {
      throw new Error(`Saved ID chain is incomplete or inconsistent for source ${id}`);
    }
    for (const endpoint of ["inspection", "diagnosis", "insurance"]) {
      const state = object(endpoints[endpoint]);
      if (state.state !== "skipped" || state.reasonCode !== `${endpoint}_not_requested_after_options_isolation`) {
        throw new Error(`Source ${id} no longer matches the expected skipped ${endpoint} report`);
      }
    }
    for (const identifier of new Set([id, String(identifiers.canonicalId), String(identifiers.vehicleNo)])) {
      const owner = identityOwners.get(identifier);
      if (owner && owner !== String(identifiers.canonicalId)) throw new Error(`Target set still contains an identifier collision for source ${id}`);
      identityOwners.set(identifier, String(identifiers.canonicalId));
    }
  }
  const allIdentifiers = [...identityOwners.keys()];
  const links: Array<{ source_identifier: string; vehicle_id: string }> = [];
  for (let offset = 0; offset < allIdentifiers.length; offset += 200) {
    const { data, error } = await db.from("vehicle_source_identifiers").select("source_identifier,vehicle_id")
      .in("source_identifier", allIdentifiers.slice(offset, offset + 200));
    if (error) throw new Error(error.message);
    links.push(...(data ?? []));
  }
  const linkedVehicleIds = [...new Set(links.map((row) => String(row.vehicle_id)))];
  const linkedVehicles: Array<{ id: string; source_listing_id: string }> = [];
  for (let offset = 0; offset < linkedVehicleIds.length; offset += 200) {
    const { data, error } = await db.from("vehicles").select("id,source_listing_id")
      .in("id", linkedVehicleIds.slice(offset, offset + 200));
    if (error) throw new Error(error.message);
    linkedVehicles.push(...(data ?? []));
  }
  const listingByVehicle = new Map(linkedVehicles.map((row) => [String(row.id), String(row.source_listing_id)]));
  for (const link of links) {
    if (listingByVehicle.get(String(link.vehicle_id)) !== identityOwners.get(String(link.source_identifier))) {
      throw new Error(`Target identifier is linked to a different catalog vehicle: ${link.source_identifier}`);
    }
  }

  const runId = randomUUID();
  const { error: runInsertError } = await db.from("chestny_enrichment_runs").insert({
    id: runId,
    project: "chestny-prigon",
    status: "awaiting_approval",
    candidate_count: EXPECTED_COUNT,
    source_file: `database:${SOURCE_RUN_ID}:audited-options-empty-745`,
    rules: {
      type: "targeted_report_refresh",
      sourceRunId: SOURCE_RUN_ID,
      targetCount: EXPECTED_COUNT,
      endpoints: ["detail", "options", "inspection", "diagnosis", "insurance", "history_availability", "history"],
      transport: "direct",
      requestDelayMs: CATALOG_POLICY.requestDelayMs,
      publication: "disabled",
      allowMatchingStagingRefresh: true,
    },
  });
  if (runInsertError) throw new Error(runInsertError.message);

  for (let offset = 0; offset < queueRows.length; offset += 100) {
    const batch = queueRows.slice(offset, offset + 100).map((row) => ({
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
  if (count !== EXPECTED_COUNT) throw new Error(`Run ${runId} remains awaiting_approval; queued count ${count}/${EXPECTED_COUNT}`);
  const { error: approveError } = await db.from("chestny_enrichment_runs")
    .update({ status: "approved" }).eq("id", runId).eq("status", "awaiting_approval");
  if (approveError) throw new Error(`Queue prepared but run ${runId} could not be approved: ${approveError.message}`);
  console.log(JSON.stringify({ status: "approved", runId, sourceRunId: SOURCE_RUN_ID, queued: count,
    requestMode: "serialized direct Encar refresh from saved IDs; no search", publication: "disabled",
    requestDelayMs: CATALOG_POLICY.requestDelayMs, globalLockChecked: true }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
