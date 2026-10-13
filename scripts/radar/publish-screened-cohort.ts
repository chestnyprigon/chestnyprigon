import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { screenStaging } from "../encar/staging-gate";
import { persistPilot } from "../encar/persistence";
import type { PilotItem } from "../encar/types";

config({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const FIRST_COHORT_RUN_ID = "fa207046-7675-45c3-810c-ee2ac7b98ba6";
const FIRST_COHORT_SIZE = 368;
const FIRST_COHORT_IDS_SHA256 = "fa6816fd02cf49078bc1716cc2495ff938d73127ae66aae4f26628246c7111e5";
const DEFAULT_MANIFEST = `output/publication-cohort-368-${FIRST_COHORT_RUN_ID}.json`;

type Manifest = {
  status: string;
  runId: string;
  cohortSize?: number;
  sourceCohortSha256?: string;
  selectedCount: number;
  selectedSourceIdsSha256: string;
  sourceListingIds: string[];
};

type StageRow = Record<string, unknown> & {
  source_listing_id: string;
  encar_payload: Record<string, unknown>;
  enrichment_status: string;
};

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) result.push(items.slice(offset, offset + size));
  return result;
}

async function main() {
  const publish = process.argv.includes("--publish");
  const manifestPath = process.argv.find((arg) => arg.startsWith("--manifest="))?.slice("--manifest=".length)
    ?? DEFAULT_MANIFEST;
  const manifest = JSON.parse(await fs.readFile(path.resolve(process.cwd(), manifestPath), "utf8")) as Manifest;
  const ids = manifest.sourceListingIds;
  const idsHash = createHash("sha256").update(ids.join("\n")).digest("hex");
  const isOriginal368 = manifest.runId === FIRST_COHORT_RUN_ID;
  if (manifest.status !== "prepared" || !manifest.runId || !Array.isArray(ids) || !ids.length
    || manifest.selectedCount !== ids.length || idsHash !== manifest.selectedSourceIdsSha256 || new Set(ids).size !== ids.length
    || (isOriginal368 && (ids.length !== FIRST_COHORT_SIZE || idsHash !== FIRST_COHORT_IDS_SHA256))) {
    throw new Error("Publication manifest is invalid or its source ID checksum does not match");
  }

  const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const runResult = await db.from("chestny_enrichment_runs").select("id,status,rules").eq("id", manifest.runId).single();
  if (runResult.error) throw new Error(`Could not read run: ${runResult.error.message}`);
  const run = runResult.data;
  if (!["running", "paused", "completed"].includes(run.status)) {
    throw new Error(`Run status ${run.status} is not eligible for a screened-cohort publication`);
  }

  const queueRows: Array<{ source_listing_id: string; status: string }> = [];
  for (const group of chunks(ids, 100)) {
    const result = await db.from("chestny_enrichment_queue").select("source_listing_id,status")
      .eq("run_id", manifest.runId).in("source_listing_id", group);
    if (result.error) throw new Error(`Could not verify queue cohort: ${result.error.message}`);
    queueRows.push(...(result.data ?? []));
  }
  const queueById = new Map(queueRows.map((row) => [row.source_listing_id, row.status]));
  const unfinished = ids.filter((id) => queueById.get(id) !== "succeeded");
  if (queueRows.length !== ids.length || unfinished.length) {
    throw new Error(`Cohort changed or is not terminal: rows=${queueRows.length}/${ids.length}, notSucceeded=${unfinished.length}`);
  }

  const stageRows: StageRow[] = [];
  for (const group of chunks(ids, 25)) {
    const result = await db.from("chestny_catalog_staging")
      .select("source_listing_id,source_url,candidate_snapshot,encar_payload,image_urls,report_status,enrichment_status,updated_at")
      .in("source_listing_id", group);
    if (result.error) throw new Error(`Could not read saved staging data: ${result.error.message}`);
    stageRows.push(...((result.data ?? []) as StageRow[]));
  }
  const byId = new Map(stageRows.map((row) => [row.source_listing_id, row]));
  const items: PilotItem[] = [];
  const rejected: Array<{ sourceListingId: string; reasons: string[] }> = [];
  for (const sourceId of ids) {
    const row = byId.get(sourceId);
    if (!row) {
      rejected.push({ sourceListingId: sourceId, reasons: ["staging_row_missing"] });
      continue;
    }
    const payload = row.encar_payload ?? {};
    const evaluated = screenStaging(row);
    const wrongRun = payload.runId !== manifest.runId;
    if (row.enrichment_status !== "succeeded" || wrongRun || evaluated.screening.decision !== "approved") {
      rejected.push({ sourceListingId: sourceId, reasons: wrongRun ? ["run_id_mismatch"]
        : row.enrichment_status !== "succeeded" ? ["enrichment_not_succeeded"] : evaluated.screening.reasonCodes });
      continue;
    }
    const { bundle, ...enrichment } = evaluated.input;
    items.push({ bundle, enrichment, screening: evaluated.screening, normalized: evaluated.normalized });
  }
  if (stageRows.length !== ids.length || rejected.length || items.length !== ids.length) {
    throw new Error(JSON.stringify({ message: "Saved cohort failed the fresh publication gate; no vehicle rows were written",
      selected: ids.length, stagingRows: stageRows.length, passed: items.length, rejected: rejected.slice(0, 25) }));
  }

  const canonicalIds = items.map((item) => String(item.normalized?.sourceListingId ?? ""));
  if (canonicalIds.some((id) => !id) || new Set(canonicalIds).size !== ids.length) {
    throw new Error("Cohort contains missing or duplicate canonical vehicle IDs");
  }
  for (const group of chunks(canonicalIds, 200)) {
    const [vehicles, identifiers] = await Promise.all([
      db.from("vehicles").select("source_listing_id").in("source_listing_id", group),
      db.from("vehicle_source_identifiers").select("source_identifier").in("source_identifier", group),
    ]);
    if (vehicles.error) throw new Error(`Could not check catalogue duplicates: ${vehicles.error.message}`);
    if (identifiers.error) throw new Error(`Could not check identity duplicates: ${identifiers.error.message}`);
    if ((vehicles.data?.length ?? 0) || (identifiers.data?.length ?? 0)) {
      throw new Error("A cohort ID is already in the catalogue; publication stopped before writes");
    }
  }

  const brandTargets = new Map<string, number>(
    (Array.isArray(run.rules?.brandQuotas) ? run.rules.brandQuotas : [])
      .filter((quota: Record<string, unknown>) => typeof quota.manufacturer === "string" && Number.isInteger(quota.publicationTarget))
      .map((quota: Record<string, unknown>) => [String(quota.manufacturer), Number(quota.publicationTarget)]),
  );
  const selectedByBrand: Record<string, number> = {};
  for (const item of items) {
    const brand = String(item.normalized?.manufacturer ?? "");
    if (!brandTargets.has(brand)) throw new Error(`No approved brand quota for ${brand}`);
    selectedByBrand[brand] = (selectedByBrand[brand] ?? 0) + 1;
  }
  const priorBatchesResult = await db.from("import_runs").select("cursor,status,accepted_count")
    .contains("cursor", { runId: manifest.runId });
  if (priorBatchesResult.error) throw new Error(`Could not read prior publication batches: ${priorBatchesResult.error.message}`);
  const priorBatchRows = (priorBatchesResult.data ?? []) as Array<{ cursor: Record<string, unknown>; status: string; accepted_count: number }>;
  const priorSourceIds = [...new Set(priorBatchRows.flatMap((row) =>
    Array.isArray(row.cursor?.sourceListingIds) ? row.cursor.sourceListingIds.map(String) : []))];
  const unattributedPriorBatches = priorBatchRows.filter((row) => row.cursor?.publish === true
    && !Array.isArray(row.cursor?.sourceListingIds) && Number(row.accepted_count ?? 0) > 0);
  const previouslyPublishedByBrand: Record<string, number> = {};
  for (const group of chunks(priorSourceIds, 200)) {
    const result = await db.from("vehicles").select("source_listing_id,manufacturer,is_public").in("source_listing_id", group);
    if (result.error) throw new Error(`Could not reconcile previous published IDs: ${result.error.message}`);
    for (const vehicle of result.data ?? []) {
      if (vehicle.is_public) previouslyPublishedByBrand[vehicle.manufacturer] = (previouslyPublishedByBrand[vehicle.manufacturer] ?? 0) + 1;
    }
  }
  const projectedByBrand: Record<string, number> = { ...previouslyPublishedByBrand };
  for (const [brand, count] of Object.entries(selectedByBrand)) projectedByBrand[brand] = (projectedByBrand[brand] ?? 0) + count;
  const quotaAdvisories = Object.entries(projectedByBrand).flatMap(([manufacturer, count]) => {
    const target = brandTargets.get(manufacturer);
    return target !== undefined && count > target
      ? [{ manufacturer, suggested: target, projected: count, aboveSuggestionBy: count - target }]
      : [];
  });
  let hardQuotaOverages: Array<{ manufacturer: string; selected: number; remaining: number; overBy: number }> = [];
  const catalogLaunchId = run.rules?.catalogLaunchId ?? null;
  if (catalogLaunchId) {
    const launch = await db.from("chestny_catalog_launches").select("id,status").eq("id", catalogLaunchId).single();
    if (launch.error) throw new Error(`Could not verify publication launch: ${launch.error.message}`);
    if (!["prepared", "running"].includes(launch.data.status)) throw new Error(`Publication launch status is ${launch.data.status}`);
    const quotas = await db.from("chestny_catalog_brand_search_status").select("manufacturer,remaining_quota")
      .eq("launch_id", catalogLaunchId);
    if (quotas.error) throw new Error(`Could not read hard launch quotas: ${quotas.error.message}`);
    const remaining = new Map((quotas.data ?? []).map((row) => [String(row.manufacturer), Number(row.remaining_quota)]));
    hardQuotaOverages = Object.entries(selectedByBrand).flatMap(([manufacturer, count]) => {
      const quota = remaining.get(manufacturer);
      if (quota === undefined) throw new Error(`No approved launch quota for ${manufacturer}`);
      return count > quota ? [{ manufacturer, selected: count, remaining: quota, overBy: count - quota }] : [];
    });
  }
  const preview = { mode: publish ? "publish" : "dry_run", runId: manifest.runId, runStatus: run.status,
    selected: ids.length, screeningPassed: items.length, selectedByBrand,
    previouslyPublishedByBrand, projectedByBrand, quotaMode: catalogLaunchId ? "hard_launch_quota" : "advisory_run_mix",
    quotaAdvisories, hardQuotaOverages, unattributedPriorBatches: unattributedPriorBatches.length,
    wouldPublishAll: hardQuotaOverages.length === 0, publicationExecuted: false,
    sourceListingIdsSha256: idsHash };
  if (!publish) {
    console.log(JSON.stringify(preview, null, 2));
    return;
  }
  if (hardQuotaOverages.length) {
    throw new Error(JSON.stringify({ ...preview, message: "Publication refused: the linked catalog launch has a hard brand quota" }, null, 2));
  }

  const result = await persistPilot(items, true, { source: "chestny-screened-cohort", runId: manifest.runId,
    requested: ids.length, publish: true, cohortSha256: idsHash, sourceListingIds: canonicalIds, selectedByBrand,
    ...(catalogLaunchId ? { catalogLaunchId } : {}) });
  console.log(JSON.stringify({ ...preview, publicationExecuted: true, result }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
