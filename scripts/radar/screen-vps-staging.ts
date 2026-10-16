import { resolveEquipment } from "../encar/equipment-resolution";
import { CATALOG_POLICY } from "../encar/catalog-policy";
import fs from "node:fs/promises";
import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { ENCAR_MAX_LISTING_AGE_DAYS } from "../encar/config";
import { screenStaging } from "../encar/staging-gate";
import { screenListing } from "../encar/screening";
import type { EncarBundle, EncarDetail, EncarSearchListing } from "../encar/types";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const RUN_ID = process.env.CHESTNY_ENRICHMENT_RUN_ID?.trim() ?? "";
const WAVE_ID = process.env.CHESTNY_ENRICHMENT_WAVE_ID?.trim() ?? "";
if (WAVE_ID && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(WAVE_ID)) throw new Error("CHESTNY_ENRICHMENT_WAVE_ID must be a wave UUID");

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function searchFromSnapshot(sourceId: string, snapshot: Record<string, unknown>): EncarSearchListing {
  const year = number(snapshot.modelYear) ?? 0;
  const priceKrw = number(snapshot.priceKrw) ?? 0;
  return {
    Id: sourceId,
    Manufacturer: String(snapshot.manufacturer ?? ""),
    Model: String(snapshot.model ?? ""),
    Year: year * 100,
    FormYear: year,
    Mileage: number(snapshot.mileageKm) ?? 0,
    Price: Math.round(priceKrw / 10_000),
    Photos: [],
    SellType: "일반",
  };
}

async function main() {
  const onlyEmptyOptions = process.argv.includes("--only-empty-options");
  const allowOptionalSkips = process.argv.includes("--assume-optional-skips-allowed");
  if (onlyEmptyOptions && !RUN_ID) throw new Error("--only-empty-options requires CHESTNY_ENRICHMENT_RUN_ID");
  if (onlyEmptyOptions && !allowOptionalSkips && !process.argv.includes("--read-only-audit")) {
    throw new Error("Persisting an empty-options cohort requires --assume-optional-skips-allowed");
  }
  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const rows: Array<Record<string, unknown>> = [];
  const cachePath = path.resolve("output", `screening-cache-${RUN_ID}${WAVE_ID ? `-${WAVE_ID}` : ""}.json`);
  const cacheKey = `${CATALOG_POLICY.version}:${new Date().toISOString().slice(0, 10)}:2`;
  type Evaluation = ReturnType<typeof screenStaging>;
  const cache: Record<string, { updatedAt: string; evaluated: Evaluation }> = {};
  if (RUN_ID && !process.argv.includes("--full")) {
    try { const saved = JSON.parse(await fs.readFile(cachePath, "utf8")); if (saved.key === cacheKey) Object.assign(cache, saved.entries); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Screening cache unavailable; performing full evaluation"); }
  }
  const activeIds = new Set<string>();
  let evaluatedRows = 0;
  let reusedRows = 0;
  const emptyOptionsRows: Array<{ sourceListingId: string; decision: string; reportStatus: string | null; standardCodeCount: number; equipmentConfirmed: boolean; assumedOptionalSkips: number }> = [];
  if (RUN_ID) {
    const sourceIds: string[] = [];
    for (let offset = 0; ; offset += 1_000) {
      let queueQuery = client.from("chestny_enrichment_queue")
        .select("source_listing_id")
        .eq("run_id", RUN_ID)
        .eq("status", "succeeded");
      if (WAVE_ID) queueQuery = queueQuery.eq("wave_id", WAVE_ID);
      const { data, error } = await queueQuery.range(offset, offset + 999);
      if (error) throw new Error(error.message);
      sourceIds.push(...(data ?? []).map((item) => String(item.source_listing_id)));
      if (!data || data.length < 1_000) break;
    }
    const changedIds: string[] = [];
    for (let offset = 0; offset < sourceIds.length; offset += 400) {
      const { data, error } = await client.from("chestny_catalog_staging").select("source_listing_id,updated_at,enrichment_status")
        .in("source_listing_id", sourceIds.slice(offset, offset + 400));
      if (error) throw new Error(error.message);
      for (const row of data ?? []) {
        if (row.enrichment_status !== "succeeded") continue;
        const saved = cache[row.source_listing_id];
        if (saved && saved.updatedAt === row.updated_at && Date.parse(String(saved.evaluated.normalized.sourceUpdatedAt ?? "")) + CATALOG_POLICY.maxListingAgeDays * 86400000 > Date.now()) rows.push({ ...row, cachedEvaluation: saved.evaluated, encar_payload: { runId: RUN_ID } });
        else changedIds.push(row.source_listing_id);
      }
    }
    // Read raw payloads only for new or changed rows.
    for (let offset = 0; offset < changedIds.length; offset += 25) {
      const { data, error } = await client.from("chestny_catalog_staging")
        .select("source_listing_id,source_url,candidate_snapshot,encar_payload,image_urls,report_status,enrichment_status,updated_at")
        .in("source_listing_id", changedIds.slice(offset, offset + 25));
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as Array<Record<string, unknown>>));
    }
  } else {
    for (let offset = 0; ; offset += 1_000) {
      const { data, error } = await client.from("chestny_catalog_staging")
        .select("source_listing_id,source_url,candidate_snapshot,encar_payload,image_urls,report_status,enrichment_status,updated_at")
        .range(offset, offset + 999);
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as Array<Record<string, unknown>>));
      if (!data || data.length < 1_000) break;
    }
  }

  if (onlyEmptyOptions) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const endpointStatus = record(record(rows[index].encar_payload).endpointStatus);
      const optionsState = String(record(endpointStatus.options).state ?? "");
      if (!["confirmed_empty", "not_found"].includes(optionsState)) rows.splice(index, 1);
    }
  }

  const readyByCanonical = new Map<string, Record<string, unknown>>();
  const freshnessCutoff = Date.now() - ENCAR_MAX_LISTING_AGE_DAYS * 24 * 60 * 60 * 1_000;
  let duplicateCanonical = 0;
  let missingPayload = 0;
  let matchingRunRows = 0;
  const reasons: Record<string, number> = {};
  const decisions: Record<string, number> = {};
  for (const row of rows) {
    const sourceId = String(row.source_listing_id ?? "");
    const snapshot = record(row.candidate_snapshot);
    const payload = record(row.encar_payload);
    if (row.enrichment_status !== "succeeded") continue;
    if (RUN_ID && payload.runId !== RUN_ID) continue;
    matchingRunRows += 1;
    if (!Object.keys(payload).length) {
      missingPayload += 1;
      continue;
    }
    activeIds.add(sourceId);
    const reused = row.cachedEvaluation as Evaluation | undefined;
    let evaluationRow = row;
    if (allowOptionalSkips) {
      const auditPayload = structuredClone(payload);
      const statuses = record(auditPayload.endpointStatus);
      let assumedOptionalSkips = 0;
      for (const endpoint of ["inspection", "diagnosis", "insurance"]) {
        const current = record(statuses[endpoint]);
        if (current.state === "skipped" && current.reasonCode === `${endpoint}_not_requested_after_options_isolation`) {
          assumedOptionalSkips += 1;
        }
      }
      auditPayload.endpointStatus = statuses;
      evaluationRow = { ...row, encar_payload: auditPayload };
      (evaluationRow as Record<string, unknown>).assumedOptionalSkips = assumedOptionalSkips;
    }
    const evaluated = reused ?? screenStaging(evaluationRow, allowOptionalSkips);
    if (reused) reusedRows += 1; else evaluatedRows += 1;
    const screening = evaluated.screening;
    decisions[screening.decision] = (decisions[screening.decision] ?? 0) + 1;
    for (const reason of screening.reasonCodes) reasons[reason] = (reasons[reason] ?? 0) + 1;
    if (["confirmed_empty", "not_found"].includes(String(record(record(payload.endpointStatus).options).state))) {
      const equipment = resolveEquipment(payload.detail, payload.choiceOptions);
      emptyOptionsRows.push({ sourceListingId: sourceId, decision: screening.decision, reportStatus: evaluated.reportStatus,
        standardCodeCount: equipment.standardCodes.length, equipmentConfirmed: equipment.confirmed,
        assumedOptionalSkips: Number(evaluationRow.assumedOptionalSkips ?? 0) });
    }
    if (!reused && !process.argv.includes("--read-only-audit")) {
      const storedDecision = await client.from("chestny_catalog_decisions").upsert({
        source_listing_id: sourceId, run_id: payload.runId ?? null, decision: screening.decision,
        rules_version: screening.rulesVersion, evidence: screening.reasonEvidence, proof: evaluated.proof,
        decided_at: new Date().toISOString(),
      }, { onConflict: "source_listing_id" });
      if (storedDecision.error) throw new Error(storedDecision.error.message);
      // Keep only evaluation, not raw endpoint payloads, in the local cache.
      const { input: _input, ...compact } = evaluated;
      cache[sourceId] = { updatedAt: String(row.updated_at), evaluated: compact as Evaluation };
    }
    if (screening.decision !== "approved") continue;
    const canonicalId = evaluated.normalized.sourceListingId;
    if (readyByCanonical.has(canonicalId)) { duplicateCanonical += 1; continue; }
    readyByCanonical.set(canonicalId, { sourceListingId: sourceId, canonicalId, reportStatus: evaluated.reportStatus,
      sourceUpdatedAt: evaluated.normalized.sourceUpdatedAt, imageCount: evaluated.normalized.imageUrls.length,
      manufacturer: evaluated.normalized.manufacturer, model: evaluated.normalized.model, modelYear: evaluated.normalized.modelYear,
      mileageKm: evaluated.normalized.mileageKm, priceKrw: evaluated.normalized.priceKrw });
  }

  let existingCanonical = 0;
  const canonicalIds = [...readyByCanonical.keys()];
  for (let offset = 0; offset < canonicalIds.length; offset += 200) {
    const chunk = canonicalIds.slice(offset, offset + 200);
    const [vehicles, identifiers] = await Promise.all([
      client.from("vehicles").select("source_listing_id").in("source_listing_id", chunk),
      client.from("vehicle_source_identifiers").select("source_identifier").in("source_identifier", chunk),
    ]);
    if (vehicles.error) throw new Error(vehicles.error.message);
    if (identifiers.error) throw new Error(identifiers.error.message);
    const known = new Set([
      ...(vehicles.data ?? []).map((item) => String(item.source_listing_id)),
      ...(identifiers.data ?? []).map((item) => String(item.source_identifier)),
    ]);
    for (const id of known) {
      if (readyByCanonical.delete(id)) existingCanonical += 1;
    }
  }

  const ready = [...readyByCanonical.values()].sort((left, right) => {
    const reportDifference = Number(right.reportStatus === "ready") - Number(left.reportStatus === "ready");
    if (reportDifference) return reportDifference;
    return Date.parse(String(right.sourceUpdatedAt)) - Date.parse(String(left.sourceUpdatedAt));
  });
  const output = {
    status: "completed",
    mode: process.argv.includes("--read-only-audit") ? "read-only-audit" : "local-screening-with-persisted-decisions",
    runId: RUN_ID,
    ...(WAVE_ID ? { waveId: WAVE_ID } : {}),
    sourceRows: matchingRunRows,
    payloadRows: matchingRunRows - missingPayload,
    missingPayload,
    freshnessDays: ENCAR_MAX_LISTING_AGE_DAYS,
    evaluatedRows, reusedRows,
    decisions,
    rejectionReasons: reasons,
    duplicateCanonical,
    existingCanonical,
    reportReady: ready.filter((item) => item.reportStatus === "ready").length,
    reportUnavailable: ready.filter((item) => item.reportStatus !== "ready").length,
    readyForPublication: ready.length,
    emptyOptionsAudit: (() => {
      const readyIds = new Set(ready.map(item => String(item.sourceListingId)));
      const approvedRows = emptyOptionsRows.filter(row => row.decision === "approved");
      return { matchingRows: emptyOptionsRows.length,
        equipmentConfirmed: emptyOptionsRows.filter(row => row.equipmentConfirmed).length,
        equipmentUnconfirmed: emptyOptionsRows.filter(row => !row.equipmentConfirmed).length,
        approvedAfterFullGate: approvedRows.length,
        stillIsolatedOrRejected: emptyOptionsRows.length - approvedRows.length,
        survivingCanonicalAndCatalogDedup: emptyOptionsRows.filter(row => readyIds.has(row.sourceListingId)).length,
        reportReadyAmongSurvivors: emptyOptionsRows.filter(row => readyIds.has(row.sourceListingId) && row.reportStatus === "ready").length,
        reportUnavailableAmongSurvivors: emptyOptionsRows.filter(row => readyIds.has(row.sourceListingId) && row.reportStatus === "unavailable").length,
        assumedOptionalReportSkips: emptyOptionsRows.reduce((sum,row)=>sum+row.assumedOptionalSkips,0),
        readOnly: process.argv.includes("--read-only-audit"), assumption: process.argv.includes("--assume-optional-skips-allowed") ? "Explicitly skipped optional reports are treated as unavailable; no source response is asserted." : null };
    })(),
    targetFilter: onlyEmptyOptions ? "options.state in (confirmed_empty, not_found)" : null,
    targetedSourceListingIds: process.argv.includes("--include-target-ids") ? emptyOptionsRows.map(row => row.sourceListingId) : undefined,
    ready,
  };
  await fs.mkdir(path.resolve(process.cwd(), "output"), { recursive: true });
  const outputFile = process.env.CHESTNY_PUBLICATION_OUTPUT_PATH?.trim() || "output/chestny-vps-publication-ready.json";
  await fs.writeFile(path.resolve(process.cwd(), outputFile), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  if (RUN_ID && !onlyEmptyOptions) {
    for (const id of Object.keys(cache)) if (!activeIds.has(id)) delete cache[id];
    if (!process.argv.includes("--read-only-audit")) {
      await fs.writeFile(`${cachePath}.tmp`, JSON.stringify({ key: cacheKey, entries: cache }), { mode: 0o600 });
      await fs.rename(`${cachePath}.tmp`, cachePath);
    }
  }
  if (WAVE_ID && !process.argv.includes("--read-only-audit")) {
    const now = new Date().toISOString();
    const { error: waveError } = await client.from("chestny_enrichment_waves").update({
      status: "ready", last_error: null, screening_completed_at: now, completed_at: now, updated_at: now,
    }).eq("id", WAVE_ID).eq("run_id", RUN_ID).in("status", ["enriched", "screening", "ready"]);
    if (waveError) throw new Error(`Could not checkpoint screened wave ${WAVE_ID}: ${waveError.message}`);
  }
  console.log(JSON.stringify({ ...output, ready: output.ready.slice(0, 20), outputFile }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
