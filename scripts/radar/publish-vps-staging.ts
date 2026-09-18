import fs from "node:fs/promises";
import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { normalizeListing } from "../encar/normalize";
import { screenListing } from "../encar/screening";
import { persistPilot } from "../encar/persistence";
import type { EncarBundle, EncarSearchListing, PilotItem } from "../encar/types";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const limit = Math.min(1_500, Math.max(1, Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? 1_000)));
const offsetStart = Math.max(0, Number(process.argv.find((arg) => arg.startsWith("--offset="))?.split("=")[1] ?? 0));
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
  const report = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "output/chestny-vps-publication-ready.json"), "utf8")) as {
    ready: Array<{ sourceListingId: string }>;
  };
  const selectedIds = report.ready.slice(offsetStart, offsetStart + limit).map((item) => item.sourceListingId);
  if (!selectedIds.length) throw new Error("No publication-ready staging IDs");

  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < selectedIds.length; offset += 200) {
    const { data, error } = await client
      .from("chestny_catalog_staging")
      .select("source_listing_id,candidate_snapshot,encar_payload,image_urls,report_status,updated_at")
      .in("source_listing_id", selectedIds.slice(offset, offset + 200));
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Array<Record<string, unknown>>));
  }

  const items: PilotItem[] = [];
  for (const row of rows) {
    const sourceId = String(row.source_listing_id ?? "");
    const snapshot = record(row.candidate_snapshot);
    const payload = record(row.encar_payload);
    const detail = record(payload.detail);
    const images = Array.isArray(row.image_urls) ? row.image_urls : [];
    if (!sourceId || !Object.keys(detail).length || images.length < 5) continue;
    const bundle: EncarBundle = {
      fetchedAt: String(row.updated_at ?? new Date().toISOString()),
      search: searchFromSnapshot(sourceId, snapshot),
      detail,
    };
    const screening = screenListing(bundle);
    if (screening.decision !== "approved") continue;
    items.push({ bundle, screening, normalized: normalizeListing(bundle) });
  }

  if (items.length !== selectedIds.length) throw new Error(`Staging quality changed: selected=${selectedIds.length}, publishable=${items.length}`);
  const uniqueItems = [
    ...new Map(items.map((item) => [String(item.normalized!.sourceListingId), item])).values(),
  ];
  const rowBySource = new Map(rows.map((row) => [String(row.source_listing_id), row]));
  const totals = { fetchedCount: 0, acceptedCount: 0, rejectedCount: 0, errorCount: 0, reportRows: 0, batches: 0 };
  for (let offset = 0; offset < uniqueItems.length; offset += 100) {
    const batch = uniqueItems.slice(offset, offset + 100);
    // Encar's advertised listing ID can differ from the canonical vehicle ID
    // returned in the detail payload. Persistence uses the canonical ID as the
    // vehicle source key, so use that key when resolving stored vehicles.
    const batchIds = batch.map((item) => String(item.normalized!.sourceListingId));
    const result = await persistPilot(batch, true, { source: "chestny-vps-staging", runId, requested: batch.length, offset, publish: true });
    totals.fetchedCount += result.fetchedCount;
    totals.acceptedCount += result.acceptedCount;
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
        accident_summary: payload.accidentSummary ?? {},
        report_status: row.report_status === "ready" ? "ready" : "unavailable",
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
