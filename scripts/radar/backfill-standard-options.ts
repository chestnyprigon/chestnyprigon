import fs from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { encarOptionsUrl, extractStandardOptionCodes } from "./standard-options";

config({ path: ".env.local", quiet: true });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function argument(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1];
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const runId = required("CHESTNY_ENRICHMENT_RUN_ID");
const delayMs = argument("delay-ms", 1_500, 1_000, 10_000);
const limit = argument("limit", 5_000, 1, 5_000);
const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

type ReadyItem = { sourceListingId: string; canonicalId: string };
type Vehicle = { id: string; source_listing_id: string };
type VehicleReport = { vehicle_id: string; inspection_summary: Record<string, unknown> | null };

async function fetchStandardCodes(sourceListingId: string, canonicalId: string) {
  const url = encarOptionsUrl(sourceListingId);
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json, text/plain, */*", Origin: "https://fem.encar.com", Referer: "https://fem.encar.com/" },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) {
        const payload = await response.json() as unknown;
        return extractStandardOptionCodes(payload, canonicalId);
      }
      lastError = `HTTP ${response.status}`;
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (/^(source_listing_unavailable|canonical_id_mismatch|standard_options_missing)$/u.test(lastError)) break;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
  throw new Error(lastError);
}

async function main() {
  const reportPath = path.resolve("output/chestny-vps-publication-ready.json");
  const publication = JSON.parse(await fs.readFile(reportPath, "utf8")) as { runId: string; ready: ReadyItem[] };
  if (publication.runId !== runId) throw new Error(`Publication report runId mismatch: ${publication.runId}`);
  const selected = publication.ready.slice(0, limit);
  const canonicalIds = [...new Set(selected.map((item) => String(item.canonicalId)))];
  const vehicles: Vehicle[] = [];
  for (let offset = 0; offset < canonicalIds.length; offset += 200) {
    const { data, error } = await client.from("vehicles").select("id,source_listing_id")
      .eq("is_public", true).eq("status", "active").in("source_listing_id", canonicalIds.slice(offset, offset + 200));
    if (error) throw new Error(error.message);
    vehicles.push(...(data ?? []) as Vehicle[]);
  }
  const reports: VehicleReport[] = [];
  for (let offset = 0; offset < vehicles.length; offset += 200) {
    const { data, error } = await client.from("vehicle_reports").select("vehicle_id,inspection_summary")
      .in("vehicle_id", vehicles.slice(offset, offset + 200).map((vehicle) => vehicle.id));
    if (error) throw new Error(error.message);
    reports.push(...(data ?? []) as VehicleReport[]);
  }
  const vehicleByCanonical = new Map(vehicles.map((vehicle) => [String(vehicle.source_listing_id), vehicle]));
  const reportByVehicle = new Map(reports.map((report) => [report.vehicle_id, report]));
  const work = selected.flatMap((item) => {
    const vehicle = vehicleByCanonical.get(String(item.canonicalId));
    const report = vehicle ? reportByVehicle.get(vehicle.id) : undefined;
    return vehicle && report && record(report.inspection_summary).standardOptionCodesAvailable !== true
      ? [{ sourceListingId: String(item.sourceListingId), canonicalId: String(item.canonicalId), vehicleId: vehicle.id, summary: record(report.inspection_summary) }]
      : [];
  });
  const missingTargets = selected.length - work.length - selected.filter((item) => {
    const vehicle = vehicleByCanonical.get(String(item.canonicalId));
    const report = vehicle ? reportByVehicle.get(vehicle.id) : undefined;
    return Boolean(vehicle && report && record(report.inspection_summary).standardOptionCodesAvailable === true);
  }).length;
  let updated = 0;
  let skippedAvailable = selected.length - work.length - missingTargets;
  const failures: Array<{ sourceListingId: string; canonicalId: string; error: string }> = [];
  console.log(JSON.stringify({ status: "started", runId, targeted: work.length, skippedAvailable, missingTargets, delayMs, transport: "direct", published: false }));
  for (const [index, item] of work.entries()) {
    try {
      const standardOptionCodes = await fetchStandardCodes(item.sourceListingId, item.canonicalId);
      const { error } = await client.from("vehicle_reports").update({
        inspection_summary: { ...item.summary, standardOptionCodes, standardOptionCodesAvailable: true },
      }).eq("vehicle_id", item.vehicleId);
      if (error) throw new Error(error.message);
      updated += 1;
    } catch (error) {
      failures.push({ sourceListingId: item.sourceListingId, canonicalId: item.canonicalId, error: error instanceof Error ? error.message : String(error) });
    }
    if ((index + 1) % 25 === 0 || index + 1 === work.length) {
      console.log(JSON.stringify({ processed: index + 1, targeted: work.length, updated, failed: failures.length }));
    }
    if (index + 1 < work.length) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  console.log(JSON.stringify({ status: "completed", runId, targeted: work.length, updated, failed: failures.length, skippedAvailable, missingTargets, failures: failures.slice(0, 25) }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
