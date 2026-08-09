import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
  Referer: "https://www.encar.com/",
  Origin: "https://www.encar.com",
};

type RecordValue = Record<string, unknown>;

function requireEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function record(value: unknown): RecordValue {
  return value && typeof value === "object" ? (value as RecordValue) : {};
}

function string(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson(url: string) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) return null;
  return response.json() as Promise<unknown>;
}

function flattenInspection(nodes: unknown, output: Array<{ title: string; status: string }>) {
  if (!Array.isArray(nodes) || output.length >= 18) return;
  for (const node of nodes) {
    const value = record(node);
    const title = string(record(value.type).title);
    const status = string(record(value.statusType).title);
    if (title && status) output.push({ title, status });
    flattenInspection(value.children, output);
    if (output.length >= 18) return;
  }
}

function inspectionSummary(payload: unknown, listingPayload: unknown) {
  const inspection = record(payload);
  const master = record(inspection.master);
  const detail = record(master.detail);
  const usageHistory = Array.isArray(detail.usageChangeTypes)
    ? detail.usageChangeTypes.map((item) => string(record(item).title)).filter(Boolean)
    : [];
  const checks: Array<{ title: string; status: string }> = [];
  flattenInspection(inspection.inners, checks);
  const bodyFindings = Array.isArray(inspection.outers)
    ? inspection.outers
        .slice(0, 18)
        .map((item) => {
          const value = record(item);
          const statuses = Array.isArray(value.statusTypes)
            ? value.statusTypes.map((status) => string(record(status).title)).filter(Boolean)
            : [];
          return { title: string(record(value.type).title) ?? "Кузов", statuses };
        })
    : [];
  const listingOptions = record(record(listingPayload).detail).options;
  const standardOptionCodes = Array.isArray(record(listingOptions).standard)
    ? (record(listingOptions).standard as unknown[]).map(string).filter((item): item is string => Boolean(item))
    : [];

  return {
    state: string(record(detail.carStateType).title) ?? string(record(detail.boardStateType).title),
    reportedAccident: Boolean(master.accdient),
    simpleRepair: Boolean(master.simpleRepair),
    waterlog: Boolean(detail.waterlog),
    tuning: Boolean(detail.tuning),
    recallCompleted: Boolean(detail.recall),
    usageHistory,
    firstRegistrationDate: string(detail.firstRegistrationDate),
    inspectionMileage: number(detail.mileage) || null,
    checks,
    bodyFindings,
    standardOptionCodes,
  };
}

function accidentSummary(payload: unknown) {
  const report = record(payload);
  return {
    available: Boolean(report.openData),
    accidentCount: number(report.accidentCnt),
    ownAccidentCount: number(report.myAccidentCnt),
    otherAccidentCount: number(report.otherAccidentCnt),
    ownerChangeCount: number(report.ownerChangeCnt),
    ownAccidentCostKrw: number(report.myAccidentCost),
    otherAccidentCostKrw: number(report.otherAccidentCost),
    totalLossCount: number(report.totalLossCnt),
    floodTotalLossCount: number(report.floodTotalLossCnt),
    floodPartLossCount: number(report.floodPartLossCnt),
    theftCount: number(report.robberCnt),
    loanCount: number(report.loan),
  };
}

function usageFlags(summary: ReturnType<typeof inspectionSummary>) {
  const allUsage = summary.usageHistory.join(" ").toLowerCase();
  return {
    rental: allUsage.includes("렌트"),
    taxi: allUsage.includes("택시"),
    commercial: allUsage.includes("영업") || allUsage.includes("화물"),
  };
}

async function main() {
  const applyScreening = process.argv.includes("--apply-screening");
  const client = createClient(
    requireEnvironment("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data: vehicles, error: vehicleError } = await client
    .from("vehicles")
    .select("id,source_listing_id")
    .eq("status", "active")
    .limit(100);
  if (vehicleError) throw new Error(vehicleError.message);
  const sourceIds = (vehicles ?? []).map((vehicle) => vehicle.source_listing_id);
  const { data: rawRows, error: rawError } = await client
    .from("encar_raw_listings")
    .select("source_listing_id,payload")
    .in("source_listing_id", sourceIds);
  if (rawError) throw new Error(rawError.message);

  const rawBySource = new Map((rawRows ?? []).map((row) => [row.source_listing_id, row.payload]));
  const reportRows: RecordValue[] = [];
  const screeningRows: RecordValue[] = [];
  const unpublishIds: string[] = [];
  let unavailable = 0;

  for (const vehicle of vehicles ?? []) {
    const payload = record(rawBySource.get(vehicle.source_listing_id));
    const detail = record(payload.detail);
    const canonicalId = string(detail.vehicleId);
    const vehicleNo = string(detail.vehicleNo);
    if (!canonicalId || !vehicleNo) {
      unavailable += 1;
      continue;
    }

    const [optionsPayload, inspectionPayload, accidentPayload] = await Promise.all([
      fetchJson(`https://api.encar.com/v1/readside/vehicles/car/${canonicalId}/options/choice`),
      fetchJson(`https://api.encar.com/v1/readside/inspection/vehicle/${canonicalId}`),
      fetchJson(
        `https://api.encar.com/v1/readside/record/vehicle/${canonicalId}/open?vehicleNo=${encodeURIComponent(vehicleNo)}`,
      ),
    ]);
    const options = Array.isArray(optionsPayload)
      ? optionsPayload.slice(0, 80).flatMap((option) => {
          const value = record(option);
          const name = string(value.optionName);
          return name
            ? [{ name, priceKrw: number(value.price) ? number(value.price) * 10_000 : null, description: string(value.description) }]
            : [];
        })
      : [];
    const inspection = inspectionSummary(inspectionPayload, payload);
    const accidents = accidentSummary(accidentPayload);
    const flags = usageFlags(inspection);
    const hasAccident = accidents.accidentCount > 0 || inspection.reportedAccident;
    const hardExclusion = flags.rental || flags.taxi || flags.commercial;

    reportRows.push({
      vehicle_id: vehicle.id,
      canonical_vehicle_id: canonicalId,
      options,
      inspection_summary: inspection,
      accident_summary: accidents,
      report_status: optionsPayload || inspectionPayload || accidentPayload ? "ready" : "unavailable",
      fetched_at: new Date().toISOString(),
    });

    if (applyScreening && (hardExclusion || hasAccident)) {
      const reasonCodes = [
        ...(flags.rental ? ["inspection_rental_history"] : []),
        ...(flags.taxi ? ["inspection_taxi_history"] : []),
        ...(flags.commercial ? ["inspection_commercial_history"] : []),
        ...(hasAccident ? ["encar_accident_history"] : []),
      ];
      screeningRows.push({
        source_listing_id: vehicle.source_listing_id,
        decision: hardExclusion ? "rejected" : "manual_review",
        is_lease: false,
        is_rental: flags.rental,
        is_taxi: flags.taxi,
        is_commercial: flags.commercial,
        is_problematic: hasAccident,
        reason_codes: reasonCodes,
        rules_version: "2026-08-09.2-enrichment",
        details: { inspection, accidents },
      });
      unpublishIds.push(vehicle.id);
    }

    console.log(`${vehicle.source_listing_id}: ${options.length} options, ${accidents.accidentCount} accidents${hardExclusion ? ", excluded" : hasAccident ? ", review" : ""}`);
    await delay(350);
  }

  if (reportRows.length) {
    const { error } = await client.from("vehicle_reports").upsert(reportRows, { onConflict: "vehicle_id" });
    if (error) throw new Error(error.message);
  }
  if (applyScreening && screeningRows.length) {
    const { error: screeningError } = await client
      .from("listing_screening")
      .upsert(screeningRows, { onConflict: "source_listing_id" });
    if (screeningError) throw new Error(screeningError.message);
    const { error: unpublishError } = await client
      .from("vehicles")
      .update({ is_public: false })
      .in("id", unpublishIds);
    if (unpublishError) throw new Error(unpublishError.message);
  }

  console.log({
    enriched: reportRows.length,
    unavailable,
    screeningApplied: applyScreening,
    unpublished: unpublishIds.length,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
