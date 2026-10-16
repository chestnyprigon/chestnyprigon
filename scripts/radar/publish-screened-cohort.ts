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
  const isOriginal368 = manifest.runId === FIRST_COHORT_RUN_ID
    && path.resolve(manifestPath) === path.resolve(DEFAULT_MANIFEST);
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
  const canonicalIdSet = new Set(canonicalIds);
  if (canonicalIds.some((id) => !id) || new Set(canonicalIds).size !== ids.length) {
    throw new Error("Cohort contains missing or duplicate canonical vehicle IDs");
  }
  const canonicalBySource = new Map(ids.map((sourceId, index) => [sourceId, canonicalIds[index]]));
  const existingManifestResult = await db.from("chestny_catalog_publication_manifests")
    .select("id,status,selected_count,source_cohort_sha256")
    .eq("run_id", manifest.runId).eq("selected_source_ids_sha256", idsHash).maybeSingle();
  if (existingManifestResult.error) throw new Error(`Could not read saved publication manifest: ${existingManifestResult.error.message}`);
  const existingManifest = existingManifestResult.data as null | {
    id: string; status: string; selected_count: number; source_cohort_sha256: string | null;
  };
  const existingManifestItems = new Map<string, { canonical_id: string; status: string }>();
  const existingManifestCanonicalIds = new Set<string>();
  if (existingManifest) {
    const savedItems = await db.from("chestny_catalog_publication_manifest_items")
      .select("source_listing_id,canonical_id,status")
      .eq("manifest_id", existingManifest.id);
    if (savedItems.error) throw new Error(`Could not read saved publication roster: ${savedItems.error.message}`);
    for (const item of savedItems.data ?? []) {
      existingManifestItems.set(item.source_listing_id, { canonical_id: item.canonical_id, status: item.status });
      existingManifestCanonicalIds.add(item.canonical_id);
    }
    if (existingManifest.selected_count !== ids.length || existingManifest.source_cohort_sha256 !== (manifest.sourceCohortSha256 ?? null)
      || existingManifestItems.size !== ids.length
      || ids.some((id) => existingManifestItems.get(id)?.canonical_id !== canonicalBySource.get(id))) {
      throw new Error("Saved publication manifest does not match the selected source IDs and canonical IDs");
    }
  }
  for (const group of chunks(canonicalIds, 200)) {
    const [vehicles, identifiers] = await Promise.all([
      db.from("vehicles").select("source_listing_id").in("source_listing_id", group),
      db.from("vehicle_source_identifiers").select("source_identifier").in("source_identifier", group),
    ]);
    if (vehicles.error) throw new Error(`Could not check catalogue duplicates: ${vehicles.error.message}`);
    if (identifiers.error) throw new Error(`Could not check identity duplicates: ${identifiers.error.message}`);
    const unexpectedVehicles = (vehicles.data ?? []).filter((vehicle) =>
      !existingManifestCanonicalIds.has(vehicle.source_listing_id));
    const unexpectedIdentifiers = (identifiers.data ?? []).filter((identifier) =>
      !canonicalIdSet.has(identifier.source_identifier)
      || !existingManifestCanonicalIds.has(String(identifier.source_identifier)));
    if (unexpectedVehicles.length || unexpectedIdentifiers.length) {
      throw new Error("A cohort ID is already in the catalogue outside this saved publication manifest; publication stopped before writes");
    }
  }

  const brandTargets = new Map<string, number>(
    (Array.isArray(run.rules?.brandQuotas) ? run.rules.brandQuotas : [])
      .filter((quota: Record<string, unknown>) => typeof quota.manufacturer === "string" && Number.isInteger(quota.publicationTarget))
      .map((quota: Record<string, unknown>) => [String(quota.manufacturer), Number(quota.publicationTarget)]),
  );
  const recommendedRemainingByBrand = new Map<string, number>();
  const catalogLaunchId = run.rules?.catalogLaunchId ?? null;
  if (catalogLaunchId) {
    const launch = await db.from("chestny_catalog_launches").select("id,status").eq("id", catalogLaunchId).single();
    if (launch.error) throw new Error(`Could not verify publication launch: ${launch.error.message}`);
    if (!["prepared", "running"].includes(launch.data.status)) throw new Error(`Publication launch status is ${launch.data.status}`);
    const quotas = await db.from("chestny_catalog_brand_search_status").select("manufacturer,target,remaining_quota")
      .eq("launch_id", catalogLaunchId);
    if (quotas.error) throw new Error(`Could not read launch brand recommendations: ${quotas.error.message}`);
    for (const quota of quotas.data ?? []) {
      brandTargets.set(String(quota.manufacturer), Number(quota.target));
      recommendedRemainingByBrand.set(String(quota.manufacturer), Number(quota.remaining_quota));
    }
  }
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
  const alreadyPublishedInCohortByBrand: Record<string, number> = {};
  for (const group of chunks(priorSourceIds, 200)) {
    const result = await db.from("vehicles").select("source_listing_id,manufacturer,is_public").in("source_listing_id", group);
    if (result.error) throw new Error(`Could not reconcile previous published IDs: ${result.error.message}`);
    for (const vehicle of result.data ?? []) {
      if (vehicle.is_public) {
        previouslyPublishedByBrand[vehicle.manufacturer] = (previouslyPublishedByBrand[vehicle.manufacturer] ?? 0) + 1;
        if (canonicalIdSet.has(vehicle.source_listing_id)) {
          alreadyPublishedInCohortByBrand[vehicle.manufacturer] = (alreadyPublishedInCohortByBrand[vehicle.manufacturer] ?? 0) + 1;
        }
      }
    }
  }
  const remainingToPublishByBrand = Object.fromEntries(Object.entries(selectedByBrand).map(([brand, count]) =>
    [brand, Math.max(0, count - (alreadyPublishedInCohortByBrand[brand] ?? 0))]));
  const projectedByBrand: Record<string, number> = { ...previouslyPublishedByBrand };
  for (const [brand, count] of Object.entries(remainingToPublishByBrand)) projectedByBrand[brand] = (projectedByBrand[brand] ?? 0) + count;
  const quotaAdvisories = Object.entries(projectedByBrand).flatMap(([manufacturer, count]) => {
    const target = brandTargets.get(manufacturer);
    return target !== undefined && count > target
      ? [{ manufacturer, suggested: target, projected: count, aboveSuggestionBy: count - target }]
      : [];
  });
  const remainingQuotaAdvisories = Object.entries(remainingToPublishByBrand).flatMap(([manufacturer, count]) => {
    const suggestedRemaining = recommendedRemainingByBrand.get(manufacturer);
    return suggestedRemaining !== undefined && count > suggestedRemaining
      ? [{ manufacturer, selected: count, suggestedRemaining, aboveRecommendationBy: count - suggestedRemaining }]
      : [];
  });
  const preview = { mode: publish ? "publish" : "dry_run", runId: manifest.runId, runStatus: run.status,
    selected: ids.length, screeningPassed: items.length, selectedByBrand,
    previouslyPublishedByBrand, alreadyPublishedInCohortByBrand, remainingToPublishByBrand,
    projectedByBrand, quotaMode: "advisory_brand_mix",
    quotaAdvisories, remainingQuotaAdvisories, unattributedPriorBatches: unattributedPriorBatches.length,
    wouldPublishAll: true, publicationExecuted: false,
    sourceListingIdsSha256: idsHash };
  if (!publish) {
    console.log(JSON.stringify(preview, null, 2));
    return;
  }
  const roster = ids.map((sourceListingId, index) => ({ position: index + 1, source_listing_id: sourceListingId,
    canonical_id: canonicalIds[index], manufacturer: String(items[index].normalized?.manufacturer ?? "") }));
  const registered = await db.rpc("register_chestny_catalog_publication_manifest", {
    p_run_id: manifest.runId,
    p_selected_source_ids_sha256: idsHash,
    p_source_cohort_sha256: manifest.sourceCohortSha256 ?? null,
    p_items: roster,
  });
  if (registered.error) throw new Error(`Could not register immutable publication manifest: ${registered.error.message}`);
  const publicationManifestId = String(registered.data);
  const persistedManifest = await db.from("chestny_catalog_publication_manifests")
    .select("id,status,selected_count").eq("id", publicationManifestId).single();
  if (persistedManifest.error) throw new Error(`Could not verify publication manifest: ${persistedManifest.error.message}`);
  if (persistedManifest.data.selected_count !== ids.length) throw new Error("Saved publication manifest count does not match the selected cohort");
  if (persistedManifest.data.status === "completed") {
    console.log(JSON.stringify({ ...preview, publicationManifestId, publicationManifestStatus: "completed",
      publicationExecuted: true, resumed: true, publishedCount: ids.length }, null, 2));
    return;
  }

  let publishedCount = 0;
  let failedCount = 0;
  const batchLimit = 10;
  const resumeFailedItems = existingManifest?.status === "paused";
  try {
    while (true) {
      const claimed = await db.rpc("claim_chestny_catalog_publication_items", {
        p_manifest_id: publicationManifestId, p_limit: batchLimit, p_lease_minutes: 30,
        p_retry_exhausted: resumeFailedItems,
      });
      if (claimed.error) throw new Error(`Could not claim publication items: ${claimed.error.message}`);
      const claimRows = (claimed.data ?? []) as Array<{ source_listing_id: string; canonical_id: string }>;
      if (!claimRows.length) break;
      const sourceIds = claimRows.map((row) => row.source_listing_id);
      const currentVehicles = await db.from("vehicles").select("id,source_listing_id,is_public")
        .in("source_listing_id", claimRows.map((row) => row.canonical_id));
      if (currentVehicles.error) throw new Error(`Could not reconcile claimed publication items: ${currentVehicles.error.message}`);
      const currentBySource = new Map((currentVehicles.data ?? []).map((vehicle) => [vehicle.source_listing_id, vehicle]));
      const alreadyPublic: string[] = [];
      const needsPersist: typeof items = [];
      let batchPublished = 0;
      let batchFailed = 0;
      for (const sourceId of sourceIds) {
        const canonical = canonicalBySource.get(sourceId)!;
        const current = currentBySource.get(canonical);
        if (current?.is_public) {
          const finished = await db.rpc("finish_chestny_catalog_publication_item", {
            p_manifest_id: publicationManifestId, p_source_listing_id: sourceId,
            p_status: "published", p_vehicle_id: current.id, p_error: null,
          });
          if (finished.error) throw new Error(`Could not reconcile already-public item ${sourceId}: ${finished.error.message}`);
          alreadyPublic.push(sourceId);
          publishedCount += 1;
          batchPublished += 1;
        } else {
          const itemIndex = ids.indexOf(sourceId);
          needsPersist.push(items[itemIndex]);
        }
      }
      if (needsPersist.length) {
        try {
          const result = await persistPilot(needsPersist, true, {
            source: "chestny-screened-cohort", runId: manifest.runId, publicationManifestId,
            requested: needsPersist.length, publish: true, cohortSha256: idsHash,
            sourceListingIds: needsPersist.map((item) => String(item.normalized?.sourceListingId ?? "")), selectedByBrand,
            ...(catalogLaunchId ? { catalogLaunchId } : {}),
          });
          const persistedIds = needsPersist.map((item) => String(item.normalized?.sourceListingId ?? ""));
          const verification = await db.from("vehicles").select("id,source_listing_id,is_public")
            .in("source_listing_id", persistedIds);
          if (verification.error) throw new Error(`Could not verify persisted publication batch: ${verification.error.message}`);
          const verifiedById = new Map((verification.data ?? []).map((vehicle) => [vehicle.source_listing_id, vehicle]));
          for (const item of needsPersist) {
            const sourceId = ids.find((id) => canonicalBySource.get(id) === String(item.normalized?.sourceListingId ?? ""))!;
            const vehicle = verifiedById.get(canonicalBySource.get(sourceId)!);
            if (!vehicle?.is_public) {
              const failure = await db.rpc("finish_chestny_catalog_publication_item", {
                p_manifest_id: publicationManifestId, p_source_listing_id: sourceId,
                p_status: "failed", p_vehicle_id: vehicle?.id ?? null,
                p_error: { reasonCode: "vehicle_not_public_after_persist", publishedCount: result.publishedCount },
              });
              if (failure.error) throw new Error(`Could not save failed publication item ${sourceId}: ${failure.error.message}`);
              failedCount += 1;
              batchFailed += 1;
              continue;
            }
            const finished = await db.rpc("finish_chestny_catalog_publication_item", {
              p_manifest_id: publicationManifestId, p_source_listing_id: sourceId,
              p_status: "published", p_vehicle_id: vehicle.id, p_error: null,
            });
            if (finished.error) throw new Error(`Could not save published item ${sourceId}: ${finished.error.message}`);
            publishedCount += 1;
            batchPublished += 1;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          for (const sourceId of sourceIds) {
            if (alreadyPublic.includes(sourceId)) continue;
            const currentState = await db.from("chestny_catalog_publication_manifest_items")
              .select("status").eq("manifest_id", publicationManifestId).eq("source_listing_id", sourceId).single();
            if (currentState.error || currentState.data.status !== "publishing") continue;
            const finish = await db.rpc("finish_chestny_catalog_publication_item", {
              p_manifest_id: publicationManifestId, p_source_listing_id: sourceId,
              p_status: "failed", p_vehicle_id: null, p_error: { message, reasonCode: "publication_batch_failed" },
            });
            if (finish.error) console.error(`Could not save failed item ${sourceId}: ${finish.error.message}`);
            else {
              failedCount += 1;
              batchFailed += 1;
            }
          }
        }
      }
      console.log(JSON.stringify({ publicationManifestId, batchSelected: sourceIds.length,
        batchPublished, batchFailed, publishedCount, failedCount }));
      if (batchFailed) break;
    }
    const finalItems = await db.from("chestny_catalog_publication_manifest_items")
      .select("status").eq("manifest_id", publicationManifestId);
    if (finalItems.error) throw new Error(`Could not read final publication outcomes: ${finalItems.error.message}`);
    const statuses = finalItems.data ?? [];
    const unfinished = statuses.filter((row) => row.status !== "published").length;
    publishedCount = statuses.filter((row) => row.status === "published").length;
    failedCount = statuses.filter((row) => row.status === "failed").length;
    if (unfinished === 0) {
      const statusUpdate = await db.rpc("set_chestny_catalog_publication_manifest_status", {
        p_manifest_id: publicationManifestId, p_status: "completed", p_error: null,
      });
      if (statusUpdate.error) throw new Error(`Could not complete publication manifest: ${statusUpdate.error.message}`);
    } else {
      const statusUpdate = await db.rpc("set_chestny_catalog_publication_manifest_status", {
        p_manifest_id: publicationManifestId, p_status: "paused",
        p_error: { unfinished, publishedCount, failedCount },
      });
      if (statusUpdate.error) throw new Error(`Could not pause incomplete publication manifest: ${statusUpdate.error.message}`);
    }
    console.log(JSON.stringify({ ...preview, publicationManifestId,
      publicationManifestStatus: unfinished === 0 ? "completed" : "paused",
      publicationExecuted: true, publishedCount, failedCount, unfinished }));
    if (unfinished) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.rpc("set_chestny_catalog_publication_manifest_status", {
      p_manifest_id: publicationManifestId, p_status: "paused", p_error: { message },
    });
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
