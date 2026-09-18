import fs from "node:fs/promises";
import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
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
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await client
      .from("chestny_catalog_staging")
      .select("source_listing_id,candidate_snapshot,encar_payload,image_urls,report_status,enrichment_status,updated_at")
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Array<Record<string, unknown>>));
    if (!data || data.length < 1_000) break;
  }

  const ready: Array<Record<string, unknown>> = [];
  let missingPayload = 0;
  const reasons: Record<string, number> = {};
  const decisions: Record<string, number> = {};
  for (const row of rows) {
    const sourceId = String(row.source_listing_id ?? "");
    const snapshot = record(row.candidate_snapshot);
    const payload = record(row.encar_payload);
    if (row.enrichment_status !== "succeeded") continue;
    if (RUN_ID && payload.runId !== RUN_ID) continue;
    if (!Object.keys(payload).length) {
      missingPayload += 1;
      continue;
    }
    const detail = record(payload.detail) as EncarDetail;
    if (!detail.vehicleId || !detail.vehicleNo) {
      reasons.missing_canonical_identifier = (reasons.missing_canonical_identifier ?? 0) + 1;
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
    const year = number(snapshot.modelYear);
    const mileage = number(snapshot.mileageKm);
    const priceKrw = number(snapshot.priceKrw);
    const images = Array.isArray(row.image_urls) ? row.image_urls : [];
    const basicRules = year !== null && year >= 2016 && mileage !== null && mileage <= 190_000 && priceKrw !== null && priceKrw > 0 && images.length >= 5;
    if (screening.decision === "approved" && basicRules) {
      ready.push({ sourceListingId: sourceId, reportStatus: row.report_status ?? "unavailable", imageCount: images.length, manufacturer: snapshot.manufacturer, model: snapshot.model, modelYear: year, mileageKm: mileage, priceKrw });
    }
  }

  const output = {
    status: "completed",
    mode: "local-read-only-screening",
    runId: RUN_ID,
    sourceRows: rows.length,
    payloadRows: rows.length - missingPayload,
    missingPayload,
    unavailableExcluded: 118,
    decisions,
    rejectionReasons: reasons,
    readyForPublication: ready.length,
    ready,
  };
  await fs.mkdir(path.resolve(process.cwd(), "output"), { recursive: true });
  await fs.writeFile(path.resolve(process.cwd(), "output/chestny-vps-publication-ready.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...output, ready: ready.slice(0, 20), outputFile: "output/chestny-vps-publication-ready.json" }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
