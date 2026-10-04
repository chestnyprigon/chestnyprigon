import fs from "node:fs/promises";
import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { ENCAR_MAX_LISTING_AGE_DAYS } from "../encar/config";
import { screenListing } from "../encar/screening";
import type { EncarBundle, EncarDetail, EncarSearchListing } from "../encar/types";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const RUN_ID = process.env.CHESTNY_ENRICHMENT_RUN_ID?.trim() ?? "";

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
  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const rows: Array<Record<string, unknown>> = [];
  if (RUN_ID) {
    const sourceIds: string[] = [];
    for (let offset = 0; ; offset += 1_000) {
      const { data, error } = await client.from("chestny_enrichment_queue")
        .select("source_listing_id")
        .eq("run_id", RUN_ID)
        .eq("status", "succeeded")
        .range(offset, offset + 999);
      if (error) throw new Error(error.message);
      sourceIds.push(...(data ?? []).map((item) => String(item.source_listing_id)));
      if (!data || data.length < 1_000) break;
    }
    // Enrichment payloads include raw Encar responses; keep each read small
    // enough to avoid Supabase statement timeouts on larger runs.
    for (let offset = 0; offset < sourceIds.length; offset += 25) {
      const { data, error } = await client.from("chestny_catalog_staging")
        .select("source_listing_id,candidate_snapshot,encar_payload,image_urls,report_status,enrichment_status,updated_at")
        .in("source_listing_id", sourceIds.slice(offset, offset + 25));
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as Array<Record<string, unknown>>));
    }
  } else {
    for (let offset = 0; ; offset += 1_000) {
      const { data, error } = await client.from("chestny_catalog_staging")
        .select("source_listing_id,candidate_snapshot,encar_payload,image_urls,report_status,enrichment_status,updated_at")
        .range(offset, offset + 999);
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as Array<Record<string, unknown>>));
      if (!data || data.length < 1_000) break;
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
    const detail = record(payload.detail) as EncarDetail;
    if (!detail.vehicleId || !detail.vehicleNo) {
      reasons.missing_canonical_identifier = (reasons.missing_canonical_identifier ?? 0) + 1;
      continue;
    }
    const modifiedAt = Date.parse(String(record(detail.manage).modifyDateTime ?? ""));
    if (!Number.isFinite(modifiedAt) || modifiedAt < freshnessCutoff) {
      reasons.stale_listing = (reasons.stale_listing ?? 0) + 1;
      continue;
    }
    const bundle: EncarBundle = {
      fetchedAt: String(row.updated_at ?? new Date().toISOString()),
      search: searchFromSnapshot(sourceId, snapshot),
      detail,
    };
    const screening = screenListing(bundle);
    decisions[screening.decision] = (decisions[screening.decision] ?? 0) + 1;
    for (const reason of screening.reasonCodes) reasons[reason] = (reasons[reason] ?? 0) + 1;
    if (screening.decision !== "approved") continue;
    if (record(payload.endpointStatus).options !== "ok") {
      reasons.options_request_failed = (reasons.options_request_failed ?? 0) + 1;
      continue;
    }
    const year = number(snapshot.modelYear);
    const mileage = number(snapshot.mileageKm);
    const priceKrw = number(snapshot.priceKrw);
    const images = Array.isArray(row.image_urls) ? row.image_urls : [];
    const basicRules = year !== null && year >= 2016 && mileage !== null && mileage <= 190_000 && priceKrw !== null && priceKrw > 0 && images.length >= 5;
    if (screening.decision === "approved" && basicRules) {
      const canonicalId = String(detail.vehicleId);
      const candidate = { sourceListingId: sourceId, canonicalId, reportStatus: row.report_status ?? "unavailable", sourceUpdatedAt: String(record(detail.manage).modifyDateTime), imageCount: images.length, manufacturer: snapshot.manufacturer, model: snapshot.model, modelYear: year, mileageKm: mileage, priceKrw };
      if (readyByCanonical.has(canonicalId)) {
        duplicateCanonical += 1;
        continue;
      }
      readyByCanonical.set(canonicalId, candidate);
    }
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
    mode: "local-read-only-screening",
    runId: RUN_ID,
    sourceRows: matchingRunRows,
    payloadRows: matchingRunRows - missingPayload,
    missingPayload,
    freshnessDays: ENCAR_MAX_LISTING_AGE_DAYS,
    decisions,
    rejectionReasons: reasons,
    duplicateCanonical,
    existingCanonical,
    reportReady: ready.filter((item) => item.reportStatus === "ready").length,
    reportUnavailable: ready.filter((item) => item.reportStatus !== "ready").length,
    readyForPublication: ready.length,
    ready,
  };
  await fs.mkdir(path.resolve(process.cwd(), "output"), { recursive: true });
  await fs.writeFile(path.resolve(process.cwd(), "output/chestny-vps-publication-ready.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...output, ready: output.ready.slice(0, 20), outputFile: "output/chestny-vps-publication-ready.json" }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
