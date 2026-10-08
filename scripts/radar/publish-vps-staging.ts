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

const limit = Math.min(1_500, Math.max(1, Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? 1_000)));
const offsetStart = Math.max(0, Number(process.argv.find((arg) => arg.startsWith("--offset="))?.split("=")[1] ?? 0));
const sourceIdsArgument = process.argv.find((arg) => arg.startsWith("--source-ids="))?.slice("--source-ids=".length);
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

async function main() {
  const selectedIds = sourceIdsArgument
    ? [...new Set(sourceIdsArgument.split(",").map((value) => value.trim()).filter(Boolean))]
    : (JSON.parse(await fs.readFile(path.resolve(process.cwd(), "output/chestny-vps-publication-ready.json"), "utf8")) as {
        ready: Array<{ sourceListingId: string }>;
      }).ready.slice(offsetStart, offsetStart + limit).map((item) => item.sourceListingId);
  if (sourceIdsArgument && selectedIds.length !== sourceIdsArgument.split(",").map((value) => value.trim()).filter(Boolean).length) {
    throw new Error("Publication input contains duplicate --source-ids");
  }
  if (!selectedIds.length) throw new Error("No publication-ready staging IDs");

  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const launch = await client.from("chestny_catalog_launches").select("id,status,rules").eq("name", "local-catalog-1000-20261007").single();
  if (launch.error) throw Error(launch.error.message);
  if (!["prepared", "running"].includes(launch.data.status)) throw Error("Local catalogue launch is not active");
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
  const canonicalIds = uniqueItems.map((item) => String(item.normalized!.sourceListingId));
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
  for (let offset = 0; offset < uniqueItems.length; offset += 100) {
    const batch = uniqueItems.slice(offset, offset + 100);
    // Encar's advertised listing ID can differ from the canonical vehicle ID
    // returned in the detail payload. Persistence uses the canonical ID as the
    // vehicle source key, so use that key when resolving stored vehicles.
    const batchIds = batch.map((item) => String(item.normalized!.sourceListingId));
    const result = await persistPilot(batch, true, { source: "chestny-local-staging", runId, catalogLaunchId: launch.data.id, requested: batch.length, offset, publish: true });
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
        options: payload.choiceOptions ?? [],
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
  console.log(JSON.stringify({ ...totals, selected: selectedIds.length, unique: uniqueItems.length, published: true }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
