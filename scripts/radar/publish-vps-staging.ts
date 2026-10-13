import { resolveEquipment } from "../encar/equipment-resolution";
import fs from "node:fs/promises";
import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { ENCAR_MAX_LISTING_AGE_DAYS } from "../encar/config";
import { normalizeListing } from "../encar/normalize";
import { screenListing } from "../encar/screening";
import { accidentSummary } from "../encar/enrich";
import { isolate } from "../encar/publication-gate";
import { evidence } from "../encar/catalog-policy";
import { screenStaging } from "../encar/staging-gate";
import { persistPilot } from "../encar/persistence";
import type { EncarBundle, EncarSearchListing, PilotItem } from "../encar/types";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const limit = Math.min(5_000, Math.max(1, Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? 5_000)));
const offsetStart = Math.max(0, Number(process.argv.find((arg) => arg.startsWith("--offset="))?.split("=")[1] ?? 0));
const sourceIdsArgument = process.argv.find((arg) => arg.startsWith("--source-ids="))?.slice("--source-ids=".length);
const allowPausedOwnerScreenedSet = process.argv.includes("--allow-paused-owner-screened-set");
const runId = process.env.CHESTNY_ENRICHMENT_RUN_ID ?? "vps-staging";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function searchFromSnapshot(sourceId: string, snapshot: Record<string, unknown>): EncarSearchListing {
  const year = Number(snapshot.modelYear ?? 0);
  return {
    Id: sourceId,
    Manufacturer: String(snapshot.manufacturer ?? ""),
    Model: String(snapshot.model ?? ""),
    Year: year * 100,
    FormYear: year,
    Mileage: Number(snapshot.mileageKm ?? 0),
    Price: Math.round(Number(snapshot.priceKrw ?? 0) / 10_000),
    Photos: [],
    SellType: "일반",
  };
}

type PublicationReport = {
  status?: string;
  runId?: string;
  ready?: Array<{ sourceListingId: string }>;
  readyForPublication?: number;
  screeningReadyForPublication?: number;
  identityConflicts?: { sourceListingIds?: string[]; count?: number };
};

async function main() {
  let selectedIds: string[];
  let publicationInput: PublicationReport | null = null;
  if (sourceIdsArgument !== undefined) {
    selectedIds = [...new Set(sourceIdsArgument.split(",").map((value) => value.trim()).filter(Boolean))];
  } else {
    const outputPath = process.env.CHESTNY_PUBLICATION_OUTPUT_PATH?.trim() || "output/chestny-vps-publication-ready.json";
    publicationInput = JSON.parse(await fs.readFile(path.resolve(process.cwd(), outputPath), "utf8")) as PublicationReport;
    if (runId !== "vps-staging" && publicationInput?.runId !== runId) {
      throw new Error(`Publication input belongs to run ${publicationInput?.runId ?? "unknown"}, expected ${runId}`);
    }
    selectedIds = (publicationInput?.ready ?? []).slice(offsetStart, offsetStart + limit).map((item) => item.sourceListingId);
  }
  if (allowPausedOwnerScreenedSet && (sourceIdsArgument !== undefined || !publicationInput
    || offsetStart !== 0 || selectedIds.length !== publicationInput.ready?.length)) {
    throw new Error("Paused-run publication requires the complete, unmodified ready set from its run-specific screening report");
  }
  if (sourceIdsArgument && selectedIds.length !== sourceIdsArgument.split(",").map((value) => value.trim()).filter(Boolean).length) {
    throw new Error("Publication input contains duplicate --source-ids");
  }
  if (!selectedIds.length) {
    if (sourceIdsArgument !== undefined) throw new Error("Explicit publication input contains no source IDs");
    console.log(JSON.stringify({ runId, selected: 0, unique: 0, acceptedCount: 0, errorCount: 0, published: false, skipped: "no_approved_candidates" }));
    return;
  }

  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  if (runId === "vps-staging") throw new Error("Specify CHESTNY_ENRICHMENT_RUN_ID for a single audited run");
  const run = await client.from("chestny_enrichment_runs").select("status,pause_reason,rules").eq("id", runId).single();
  if (run.error) throw new Error(run.error.message);
  const catalogLaunchId = run.data.rules?.catalogLaunchId ?? null;
  if (!catalogLaunchId && run.data.status !== "completed") {
    const ownerPausedRun = run.data.status === "paused" && record(run.data.pause_reason).source === "owner_requested";
    if (!allowPausedOwnerScreenedSet || !ownerPausedRun || publicationInput?.status !== "completed"
      || publicationInput.runId !== runId || publicationInput.readyForPublication !== selectedIds.length
      || publicationInput.screeningReadyForPublication !== 303
      || publicationInput.identityConflicts?.count !== 7
      || publicationInput.identityConflicts.sourceListingIds?.length !== 7) {
      throw new Error("Publication requires a completed run, or the exact owner-paused screened set with explicit authorization");
    }
    const [workerLock, leased, task] = await Promise.all([
      client.from("chestny_enrichment_worker_lock").select("run_id,expires_at")
        .eq("lock_name", "chestny-catalog-enrichment").maybeSingle(),
      client.from("chestny_enrichment_queue").select("id", { count: "exact", head: true })
        .eq("run_id", runId).eq("status", "leased"),
      client.from("control_center_tasks").select("state")
        .eq("module_id", "chestny-prigon.catalog").eq("external_ref", runId).maybeSingle(),
    ]);
    if (workerLock.error) throw new Error(`Could not verify worker lock: ${workerLock.error.message}`);
    if (leased.error) throw new Error(`Could not verify in-flight queue items: ${leased.error.message}`);
    if (task.error) throw new Error(`Could not verify paused catalog task: ${task.error.message}`);
    if (workerLock.data && Date.parse(workerLock.data.expires_at) > Date.now()) throw new Error("Publication blocked while an enrichment worker holds the global lock");
    if ((leased.count ?? 0) > 0) throw new Error("Publication blocked while queue items are leased");
    if (!task.data || task.data.state !== "paused") throw new Error("Publication requires the linked Control Center task to remain paused");
    const conflictIds = publicationInput.identityConflicts.sourceListingIds!;
    const { data: conflictDecisions, error: conflictError } = await client.from("chestny_catalog_decisions")
      .select("source_listing_id,run_id,decision,evidence").in("source_listing_id", conflictIds);
    if (conflictError) throw new Error(`Could not verify isolated identity conflicts: ${conflictError.message}`);
    if (conflictDecisions?.length !== conflictIds.length || conflictDecisions.some((decision) =>
      decision.run_id !== runId || decision.decision !== "isolated"
      || !Array.isArray(decision.evidence) || !decision.evidence.some((item: Record<string, unknown>) => item.code === "identity_source_identifier_collision"))) {
      throw new Error("Publication blocked: every excluded identity conflict must have a persisted isolated decision");
    }
  }
  if (catalogLaunchId) {
    const launch = await client.from("chestny_catalog_launches").select("id,status").eq("id", catalogLaunchId).single();
    if (launch.error) throw new Error(launch.error.message);
    if (!["prepared", "running"].includes(launch.data.status)) throw new Error("Catalogue launch is not active");
  }
  const rows: Array<Record<string, unknown>> = [];
  // Staging rows contain full Encar payloads; small reads avoid statement
  // timeouts when publishing larger audited runs.
  for (let offset = 0; offset < selectedIds.length; offset += 25) {
    const { data, error } = await client
      .from("chestny_catalog_staging")
      .select("source_listing_id,source_url,candidate_snapshot,encar_payload,image_urls,report_status,enrichment_status,updated_at")
      .in("source_listing_id", selectedIds.slice(offset, offset + 25));
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Array<Record<string, unknown>>));
  }

  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error(`Publication input contains duplicate staging IDs: selected=${selectedIds.length}, unique=${new Set(selectedIds).size}`);
  }

  const rowBySource = new Map(rows.map((row) => [String(row.source_listing_id), row]));
  const freshnessCutoff = Date.now() - ENCAR_MAX_LISTING_AGE_DAYS * 24 * 60 * 60 * 1_000;
  const items: PilotItem[] = [];
  const qualityRejections: Array<{ sourceListingId: string; reasons: string[] }> = [];
  for (const sourceId of selectedIds) {
    const row = rowBySource.get(sourceId);
    const reasons: string[] = [];
    if (!row) {
      qualityRejections.push({ sourceListingId: sourceId, reasons: ["staging_row_missing"] });
      continue;
    }
    const payload = record(row.encar_payload);
    const evaluated = screenStaging(row);
    if (row.enrichment_status !== "succeeded" || (runId !== "vps-staging" && payload.runId !== runId)) {
      evaluated.screening = isolate(evaluated.screening, [evidence("publication_context_unconfirmed", "Staging не принадлежит ожидаемому успешному запуску.", { expectedRunId: runId, actualRunId: payload.runId, enrichmentStatus: row.enrichment_status }, "chestny_catalog_staging")]);
    }
    const savedDecision = await client.from("chestny_catalog_decisions").upsert({ source_listing_id: sourceId,
      decision: evaluated.screening.decision, rules_version: evaluated.screening.rulesVersion,
      evidence: evaluated.screening.reasonEvidence, proof: { ...evaluated.proof, validated: evaluated.screening.decision === "approved" }, decided_at: new Date().toISOString() });
    if (savedDecision.error) throw Error(savedDecision.error.message);
    const { bundle, ...enrichment } = evaluated.input;
    const wrongRun = runId !== "vps-staging" && payload.runId !== runId;
    if (row.enrichment_status !== "succeeded" || wrongRun || evaluated.screening.decision !== "approved") {
      qualityRejections.push({ sourceListingId: sourceId, reasons: wrongRun ? ["run_id_mismatch"] : row.enrichment_status !== "succeeded" ? ["enrichment_not_succeeded"] : evaluated.screening.reasonCodes });
      continue;
    }
    items.push({ bundle, enrichment, screening: evaluated.screening, normalized: evaluated.normalized });
  }

  if (qualityRejections.length || items.length !== selectedIds.length) {
    throw new Error(JSON.stringify({
      message: "Staging quality changed; publication stopped before any write",
      selected: selectedIds.length,
      publishable: items.length,
      rejected: qualityRejections.length,
      samples: qualityRejections.slice(0, 20),
    }));
  }
  const uniqueItems = [
    ...new Map(items.map((item) => [String(item.normalized!.sourceListingId), item])).values(),
  ];
  if (uniqueItems.length !== items.length) {
    throw new Error(`Publication input contains duplicate canonical IDs: selected=${items.length}, unique=${uniqueItems.length}`);
  }
  let brandTargets = new Map<string, number>(
    (Array.isArray(run.data.rules?.brandQuotas) ? run.data.rules.brandQuotas : [])
      .filter((quota: Record<string, unknown>) => typeof quota.manufacturer === "string" && Number.isInteger(quota.publicationTarget))
      .map((quota: Record<string, unknown>) => [String(quota.manufacturer), Number(quota.publicationTarget)]),
  );
  if (catalogLaunchId) {
    const { data: quotaRows, error: quotaError } = await client.from("chestny_catalog_brand_search_status")
      .select("manufacturer,remaining_quota").eq("launch_id", catalogLaunchId);
    if (quotaError) throw new Error(`Could not load remaining publication quotas: ${quotaError.message}`);
    brandTargets = new Map((quotaRows ?? []).map((quota) => [String(quota.manufacturer), Number(quota.remaining_quota)]));
  }
  const publishedByBrand: Record<string, number> = {};
  let excludedByBrandQuota = 0;
  const quotaCappedItems = brandTargets.size ? uniqueItems.filter((item) => {
    const brand = String(item.normalized!.manufacturer);
    const target = brandTargets.get(brand);
    if (target === undefined) throw new Error(`No approved publication quota for ${brand}`);
    const current = publishedByBrand[brand] ?? 0;
    if (current >= target) { excludedByBrandQuota += 1; return false; }
    publishedByBrand[brand] = current + 1;
    return true;
  }) : uniqueItems;
  const canonicalIds = quotaCappedItems.map((item) => String(item.normalized!.sourceListingId));
  for (let offset = 0; offset < canonicalIds.length; offset += 200) {
    const chunk = canonicalIds.slice(offset, offset + 200);
    const [vehicles, identifiers] = await Promise.all([
      client.from("vehicles").select("source_listing_id").in("source_listing_id", chunk),
      client.from("vehicle_source_identifiers").select("source_identifier").in("source_identifier", chunk),
    ]);
    if (vehicles.error) throw new Error(vehicles.error.message);
    if (identifiers.error) throw new Error(identifiers.error.message);
    if ((vehicles.data?.length ?? 0) + (identifiers.data?.length ?? 0) > 0) {
      throw new Error("Publication input contains a canonical ID already in the catalogue; screening must be repeated");
    }
  }
  const totals = { fetchedCount: 0, acceptedCount: 0, rejectedCount: 0, errorCount: 0, reportRows: 0, batches: 0 };
  for (let offset = 0; offset < quotaCappedItems.length; offset += 100) {
    const batch = quotaCappedItems.slice(offset, offset + 100);
    // Encar's advertised listing ID can differ from the canonical vehicle ID
    // returned in the detail payload. Persistence uses the canonical ID as the
    // vehicle source key, so use that key when resolving stored vehicles.
    const batchIds = batch.map((item) => String(item.normalized!.sourceListingId));
    const result = await persistPilot(batch, true, { source: "chestny-local-staging", runId, catalogLaunchId: catalogLaunchId ?? "", requested: batch.length, offset, publish: true });
    totals.fetchedCount += result.fetchedCount;
    totals.acceptedCount += result.publishedCount;
    totals.rejectedCount += result.rejectedCount;
    totals.errorCount += result.errorCount;
    const stored = await client.from("vehicles").select("id,source_listing_id").in("source_listing_id", batchIds);
    if (stored.error) throw new Error(stored.error.message);
    const idBySource = new Map((stored.data ?? []).map((row) => [row.source_listing_id, row.id]));
    const reportRows = batch.flatMap((item) => {
      const sourceId = String(item.bundle.search.Id);
      const canonicalId = String(item.normalized!.sourceListingId);
      const vehicleId = idBySource.get(canonicalId);
      const row = rowBySource.get(sourceId);
      if (!vehicleId || !row) return [];
      const payload = record(row.encar_payload);
      const detail = record(payload.detail);
      return [{
        vehicle_id: vehicleId,
        canonical_vehicle_id: String(detail.vehicleId ?? sourceId),
        options: resolveEquipment(detail, payload.choiceOptions).display,
        inspection_summary: payload.inspectionSummary ?? {},
        accident_summary: accidentSummary(record(payload.rawReports).insurance, record(payload.rawReports).history),
        report_status: screenStaging(row).reportStatus,
        fetched_at: String(payload.fetchedAt ?? row.updated_at ?? new Date().toISOString()),
      }];
    });
    if (reportRows.length) {
      const { error } = await client.from("vehicle_reports").upsert(reportRows, { onConflict: "vehicle_id" });
      if (error) throw new Error(error.message);
    }
    totals.reportRows += reportRows.length;
    totals.batches += 1;
    console.log(JSON.stringify({ batch: totals.batches, offset, requested: batch.length, published: result.acceptedCount }));
  }
  console.log(JSON.stringify({ ...totals, selected: selectedIds.length, unique: uniqueItems.length,
    excludedByBrandQuota, publishedByBrand, published: true }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
