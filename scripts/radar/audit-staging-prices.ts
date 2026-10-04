import fs from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { normalizeListing } from "../encar/normalize";
import type { EncarBundle, EncarDetail } from "../encar/types";

config({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const runId = process.env.CHESTNY_ENRICHMENT_RUN_ID?.trim();
if (!runId) throw new Error("Missing CHESTNY_ENRICHMENT_RUN_ID");

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function numeric(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function median(values: number[]) {
  return percentile(values, 0.5);
}

type Candidate = {
  sourceListingId: string;
  canonicalId: string;
  manufacturer: string;
  model: string;
  modelYear: number;
  mileageKm: number;
  priceKrw: number;
  fuelType: string;
  engineCc: number | null;
};

async function main() {
  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const readyReport = JSON.parse(await fs.readFile(path.resolve("output/chestny-vps-publication-ready.json"), "utf8")) as {
    runId: string;
    ready: Array<{ sourceListingId: string }>;
  };
  if (readyReport.runId !== runId) throw new Error(`Report runId mismatch: ${readyReport.runId}`);
  const sourceIds = readyReport.ready.map((item) => item.sourceListingId);
  const stageRows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < sourceIds.length; offset += 25) {
    const { data, error } = await client.from("chestny_catalog_staging")
      .select("source_listing_id,candidate_snapshot,encar_payload")
      .in("source_listing_id", sourceIds.slice(offset, offset + 25));
    if (error) throw new Error(error.message);
    stageRows.push(...(data ?? []) as Array<Record<string, unknown>>);
  }
  const stageBySource = new Map(stageRows.map((row) => [String(row.source_listing_id), row]));
  const candidates: Candidate[] = [];
  const missingSourceIds: string[] = [];
  for (const item of readyReport.ready) {
    const sourceId = String(item.sourceListingId);
    const row = stageBySource.get(sourceId);
    if (!row) { missingSourceIds.push(sourceId); continue; }
    const snapshot = object(row.candidate_snapshot);
    const payload = object(row.encar_payload);
    const detail = object(payload.detail);
    const spec = object(detail.spec);
    const modelYear = Number(snapshot.modelYear);
    const mileageKm = Number(snapshot.mileageKm);
    const priceKrw = Number(snapshot.priceKrw);
    if (!Number.isFinite(modelYear) || !Number.isFinite(mileageKm) || !Number.isFinite(priceKrw) || priceKrw <= 0) {
      missingSourceIds.push(sourceId);
      continue;
    }
    const bundle: EncarBundle = {
      fetchedAt: new Date().toISOString(),
      search: {
        Id: sourceId,
        Manufacturer: String(snapshot.manufacturer ?? ""),
        Model: String(snapshot.model ?? ""),
        Year: modelYear * 100,
        FormYear: modelYear,
        Mileage: mileageKm,
        Price: Number(snapshot.Price ?? Math.round(priceKrw / 10_000)),
        FuelType: String(snapshot.FuelType ?? ""),
      },
      detail: detail as EncarDetail,
    };
    const normalized = normalizeListing(bundle);
    const manufacturer = String(normalized.manufacturer ?? "").trim();
    const model = String(normalized.model ?? "").trim();
    const fuelType = String(normalized.fuelType ?? spec.fuelName ?? "").trim();
    const engineCc = numeric(normalized.engineCc ?? spec.displacement);
    if (!manufacturer || !model || !fuelType) {
      missingSourceIds.push(sourceId);
      continue;
    }
    candidates.push({ sourceListingId: sourceId, canonicalId: String(detail.vehicleId ?? sourceId), manufacturer, model, modelYear, mileageKm, priceKrw, fuelType, engineCc });
  }

  const catalog: Array<Record<string, unknown>> = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client.from("vehicles")
      .select("source_listing_id,manufacturer,model,model_year,mileage_km,price_krw,fuel_type,engine_cc")
      .eq("is_public", true).eq("status", "active")
      .range(offset, offset + 499);
    if (error) throw new Error(error.message);
    catalog.push(...(data ?? []) as Array<Record<string, unknown>>);
    if (!data || data.length < 500) break;
  }

  const results = candidates.map((candidate) => {
    const sameSpecs = catalog.filter((row) =>
      row.manufacturer === candidate.manufacturer &&
      row.model === candidate.model &&
      Number(row.model_year) === candidate.modelYear &&
      String(row.fuel_type ?? "").trim() === candidate.fuelType &&
      (candidate.engineCc === null || numeric(row.engine_cc) === null || Math.abs(Number(row.engine_cc) - candidate.engineCc) <= 500),
    );
    const mileageComparable = sameSpecs.filter((row) => Math.abs(Number(row.mileage_km) - candidate.mileageKm) <= 60_000);
    const useMileageBand = mileageComparable.length >= 7;
    const comparables = useMileageBand ? mileageComparable : sameSpecs;
    const prices = comparables.map((row) => Number(row.price_krw)).filter((price) => Number.isFinite(price) && price > 0);
    const medianKrw = prices.length ? median(prices) : null;
    const q1Krw = prices.length ? percentile(prices, 0.25) : null;
    const comparableSet = useMileageBand ? "same_specs_and_mileage_±60000km" : "same_specs_mileage_unrestricted";
    const anomaly = prices.length >= 7 && medianKrw !== null && q1Krw !== null && candidate.priceKrw < medianKrw * 0.5 && candidate.priceKrw < q1Krw * 0.75;
    return {
      ...candidate,
      comparableCount: prices.length,
      comparableSet,
      medianKrw,
      firstQuartileKrw: q1Krw,
      priceToMedian: medianKrw ? Number((candidate.priceKrw / medianKrw).toFixed(3)) : null,
      priceFlag: anomaly ? "suspect_low_price" : prices.length >= 7 ? "no_extreme_low_price_signal" : "insufficient_comparables",
    };
  });
  const summary = {
    status: "completed",
    mode: "read-only-catalog-price-comparison",
    runId,
    candidatesInPublicationReport: readyReport.ready.length,
    candidatesAudited: results.length,
    missingSourceIds,
    publicActiveComparables: catalog.length,
    thresholds: { minComparables: 7, priceBelowMedianRatio: 0.5, priceBelowQ1Ratio: 0.75, mileageWindowKm: 60_000, engineWindowCc: 500 },
    counts: results.reduce<Record<string, number>>((counts, row) => {
      counts[row.priceFlag] = (counts[row.priceFlag] ?? 0) + 1;
      return counts;
    }, {}),
    results,
  };
  const outputPath = path.resolve(`output/chestny-price-audit-${runId}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...summary, results: undefined, sampleFlags: results.filter((row) => row.priceFlag !== "no_extreme_low_price_signal").slice(0, 30), outputPath: path.relative(process.cwd(), outputPath) }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
