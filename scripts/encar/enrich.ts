import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { encarPhotoUrl } from "../../src/lib/encar/images";
import { reportScreening } from "./report-screening";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
  Referer: "https://www.encar.com/",
  Origin: "https://www.encar.com",
};

const historyHeaders = {
  ...headers,
  Authorization: "Bearer WqtHVjmpGX7lWsf63vwCGVPrF1BzYk",
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

function integerArgument(name: string, fallback: number, minimum: number, maximum: number) {
  const prefix = `--${name}=`;
  const raw = process.argv.slice(2).find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

async function fetchJson(url: string, requestHeaders = headers) {
  try {
    const response = await fetch(url, { headers: requestHeaders, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    return response.json() as Promise<unknown>;
  } catch {
    return null;
  }
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
            ? value.statusTypes.flatMap((status) => {
                const current = record(status);
                const title = string(current.title);
                return title ? [{ code: string(current.code), title }] : [];
              })
            : [];
          return { code: string(record(value.type).code), title: string(record(value.type).title) ?? "Кузов", statuses };
        })
    : [];
  const listingOptions = record(record(listingPayload).detail).options;
  const listingPhotos = record(record(listingPayload).detail).photos;
  const standardOptionCodes = Array.isArray(record(listingOptions).standard)
    ? (record(listingOptions).standard as unknown[]).map(string).filter((item): item is string => Boolean(item))
    : [];
  const inspectionImages = Array.isArray(inspection.images)
    ? inspection.images.flatMap((item) => {
        const image = record(item);
        const imagePath = string(image.path);
        if (!imagePath) return [];
        const sourceTitle = string(image.title);
        const title = sourceTitle === "앞면" ? "Вид спереди" : sourceTitle === "뒷면" ? "Вид сзади" : "Фото осмотра";
        return [{ url: imagePath.startsWith("http") ? imagePath : `https://ci.encar.com${imagePath}`, title }];
      })
    : [];
  const photoGroups = Array.isArray(listingPhotos)
    ? listingPhotos.flatMap((item) => {
        const photo = record(item);
        const imagePath = string(photo.path);
        if (!imagePath) return [];
        const type = string(photo.type)?.toUpperCase();
        const group = type === "OUTER" || type === "THUMBNAIL" ? "Кузов" : type === "INNER" ? "Салон" : type === "OPTION" ? "Детали" : "Другие фото";
        return [{ url: encarPhotoUrl(imagePath.startsWith("http") ? imagePath : `https://ci.encar.com${imagePath}`), group }];
      })
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
    inspectionImages,
    photoGroups,
  };
}

function historyType(value: string | null) {
  if (value === "USE_MY_INSURANCE") return "Выплата по страховке владельца";
  if (value === "USE_OTHER_INSURANCE") return "Выплата по страховке другого участника";
  if (value === "PROPERTY_DAMAGE") return "Страховой случай: имущественный ущерб";
  return "Страховой случай";
}

function accidentSummary(payload: unknown, historyPayload: unknown) {
  const report = record(payload);
  const history = record(historyPayload);
  const insuranceEvents = Array.isArray(history.accidentHistoryResponse)
    ? history.accidentHistoryResponse.flatMap((item) => {
        const event = record(item);
        const date = string(event.accidentDate);
        const amountKrw = number(event.repairCost);
        if (!date || !amountKrw) return [];
        return [{
          date,
          type: historyType(string(event.accidentType)),
          amountKrw,
          partsKrw: number(event.partCost) || null,
          paintingKrw: number(event.paintingCost) || null,
          laborKrw: number(event.laborCost) || null,
        }];
      }).sort((left, right) => right.date.localeCompare(left.date))
    : [];
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
    insuranceEvents,
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
  const publishEligible = process.argv.includes("--publish-eligible");
  const onlyMissing = process.argv.includes("--only-missing");
  const limit = integerArgument("limit", 2_000, 1, 10_000);
  const batchSize = integerArgument("batch-size", limit, 1, 10_000);
  if (publishEligible && !applyScreening) throw new Error("--publish-eligible requires --apply-screening");
  const client = createClient(
    requireEnvironment("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const selectedVehicles: Array<{ id: string; source_listing_id: string; price_usd: number | null }> = [];
  const pageSize = 1_000;
  for (let offset = 0; selectedVehicles.length < limit; offset += pageSize) {
    const take = Math.min(pageSize, limit - selectedVehicles.length);
    const { data, error: vehicleError } = await client
      .from("vehicles")
      .select("id,source_listing_id,price_usd")
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + take - 1);
    if (vehicleError) throw new Error(vehicleError.message);
    selectedVehicles.push(...(data ?? []));
    if ((data?.length ?? 0) < take) break;
  }
  let vehicles = selectedVehicles;
  if (onlyMissing && vehicles.length) {
    const vehicleIds = vehicles.map((vehicle) => vehicle.id);
    const reportedIds = new Set<string>();
    for (let offset = 0; offset < vehicleIds.length; offset += 200) {
      const { data, error } = await client
        .from("vehicle_reports")
        .select("vehicle_id,report_status")
        .in("vehicle_id", vehicleIds.slice(offset, offset + 200));
      if (error) throw new Error(error.message);
      for (const row of data ?? []) {
        if (row.report_status === "ready") reportedIds.add(row.vehicle_id);
      }
    }
    vehicles = vehicles.filter((vehicle) => !reportedIds.has(vehicle.id));
  }
  vehicles = vehicles.slice(0, batchSize);
  console.log(`Enriching ${vehicles.length} active vehicles${onlyMissing ? " without reports" : ""}.`);
  const sourceIds = (vehicles ?? []).map((vehicle) => vehicle.source_listing_id);
  const rawRows: Array<{ source_listing_id: string; payload: unknown }> = [];
  for (let offset = 0; offset < sourceIds.length; offset += 50) {
    const { data, error } = await client
      .from("encar_raw_listings")
      .select("source_listing_id,payload")
      .in("source_listing_id", sourceIds.slice(offset, offset + 50));
    if (error) throw new Error(error.message);
    rawRows.push(...(data ?? []));
  }

  const rawBySource = new Map(rawRows.map((row) => [row.source_listing_id, row.payload]));
  const reportRows: RecordValue[] = [];
  const screeningRows: RecordValue[] = [];
  const unpublishIds: string[] = [];
  const publishIds: string[] = [];
  let unavailable = 0;

  for (const vehicle of vehicles ?? []) {
    const payload = record(rawBySource.get(vehicle.source_listing_id));
    const detail = record(payload.detail);
    const canonicalId = string(detail.vehicleId);
    const vehicleNo = string(detail.vehicleNo);
    if (!canonicalId || !vehicleNo) {
      unavailable += 1;
      if (applyScreening) {
        screeningRows.push({
          source_listing_id: vehicle.source_listing_id,
          decision: "approved",
          is_lease: false,
          is_rental: false,
          is_taxi: false,
          is_commercial: false,
          is_problematic: false,
          reason_codes: ["encar_report_unavailable"],
          rules_version: "2026-08-16.1-report-optional",
          details: { reportStatus: "unavailable" },
        });
        if (publishEligible && vehicle.price_usd !== null) publishIds.push(vehicle.id);
      }
      continue;
    }

    const [optionsPayload, inspectionPayload, accidentPayload, historyPayload] = await Promise.all([
      fetchJson(`https://api.encar.com/v1/readside/vehicles/car/${canonicalId}/options/choice`),
      fetchJson(`https://api.encar.com/v1/readside/inspection/vehicle/${canonicalId}`),
      fetchJson(
        `https://api.encar.com/v1/readside/record/vehicle/${canonicalId}/open?vehicleNo=${encodeURIComponent(vehicleNo)}`,
      ),
      fetchJson(`https://api.encar.com/v1/vehicle/resume?vehicleNo=${encodeURIComponent(vehicleNo)}`, historyHeaders),
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
    const accidents = accidentSummary(accidentPayload, historyPayload);
    const flags = usageFlags(inspection);
    const hasAccident = accidents.accidentCount > 0 || inspection.reportedAccident;
    const reportReady = Boolean(inspectionPayload && accidentPayload);
    const screening = reportScreening(flags, hasAccident, reportReady);
    if (!reportReady) unavailable += 1;

    reportRows.push({
      vehicle_id: vehicle.id,
      canonical_vehicle_id: canonicalId,
      options,
      inspection_summary: inspection,
      accident_summary: accidents,
      report_status: reportReady ? "ready" : "unavailable",
      fetched_at: new Date().toISOString(),
    });

    if (applyScreening) {
      screeningRows.push({
        source_listing_id: vehicle.source_listing_id,
        decision: screening.decision,
        is_lease: false,
        is_rental: flags.rental,
        is_taxi: flags.taxi,
        is_commercial: flags.commercial,
        is_problematic: screening.isProblematic,
        reason_codes: screening.reasonCodes,
        rules_version: "2026-08-16.1-report-optional",
        details: { inspection, accidents, reportStatus: reportReady ? "ready" : "unavailable" },
      });
      if (screening.hardExclusion) unpublishIds.push(vehicle.id);
      else if (publishEligible && vehicle.price_usd !== null) publishIds.push(vehicle.id);
    }

    console.log(`${vehicle.source_listing_id}: ${options.length} options, ${accidents.accidentCount} accidents${screening.hardExclusion ? ", excluded" : hasAccident ? ", disclosed" : ""}`);
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
    if (unpublishIds.length) {
      const { error: unpublishError } = await client
        .from("vehicles")
        .update({ is_public: false })
        .in("id", unpublishIds);
      if (unpublishError) throw new Error(unpublishError.message);
    }
    if (publishIds.length) {
      const { error: publishError } = await client
        .from("vehicles")
        .update({ is_public: true })
        .in("id", publishIds);
      if (publishError) throw new Error(publishError.message);
    }
  }

  console.log({
    enriched: reportRows.length,
    unavailable,
    screeningApplied: applyScreening,
    unpublished: unpublishIds.length,
    published: publishIds.length,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
