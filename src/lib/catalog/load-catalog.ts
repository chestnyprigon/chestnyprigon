import "server-only";
import type { AccidentSummary, CatalogCar, CarFuel, InspectionSummary, VehicleOption } from "@/data/cars";
import { calculateBelarusPrice } from "@/lib/pricing/emavto-profile";
import { createSupabasePublicServerClient } from "@/lib/supabase/public-client";

function fuelName(source: string | null): CarFuel {
  const fuel = (source ?? "").toLowerCase();
  if (fuel.includes("하이브리드") || fuel.includes("hybrid")) return "Гибрид";
  if (fuel.includes("전기") || fuel.includes("electric")) return "Электро";
  if (fuel.includes("디젤") || fuel.includes("diesel")) return "Дизель";
  if (fuel.includes("lpg") || fuel.includes("가스")) return "Газ";
  if (fuel.includes("가솔린") || fuel.includes("gasoline")) return "Бензин";
  return "Другое";
}

function locationName(source: string | null) {
  if (!source) return "Южная Корея";
  return source.replace("서울", "Сеул").replace("인천", "Инчхон").replace("부산", "Пусан");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asBoolean(value: unknown) {
  return value === true;
}

function parseOptions(value: unknown): VehicleOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const option = record(item);
    const name = asString(option.name);
    if (!name) return [];
    return [{
      name,
      priceKrw: Number.isFinite(Number(option.priceKrw)) ? Number(option.priceKrw) : null,
      description: asString(option.description),
    }];
  });
}

function parseInspection(value: unknown): InspectionSummary | null {
  if (!value || typeof value !== "object") return null;
  const summary = record(value);
  const checks = Array.isArray(summary.checks)
    ? summary.checks.flatMap((item) => {
        const check = record(item);
        const title = asString(check.title);
        const status = asString(check.status);
        return title && status ? [{ title, status }] : [];
      })
    : [];
  const bodyFindings = Array.isArray(summary.bodyFindings)
    ? summary.bodyFindings.flatMap((item) => {
        const finding = record(item);
        const title = asString(finding.title);
        const statuses = Array.isArray(finding.statuses)
          ? finding.statuses.filter((status): status is string => typeof status === "string")
          : [];
        return title ? [{ title, statuses }] : [];
      })
    : [];
  return {
    state: asString(summary.state),
    reportedAccident: asBoolean(summary.reportedAccident),
    simpleRepair: asBoolean(summary.simpleRepair),
    waterlog: asBoolean(summary.waterlog),
    tuning: asBoolean(summary.tuning),
    recallCompleted: asBoolean(summary.recallCompleted),
    usageHistory: Array.isArray(summary.usageHistory)
      ? summary.usageHistory.filter((item): item is string => typeof item === "string")
      : [],
    firstRegistrationDate: asString(summary.firstRegistrationDate),
    inspectionMileage: asNumber(summary.inspectionMileage) || null,
    checks,
    bodyFindings,
  };
}

function parseAccidents(value: unknown): AccidentSummary | null {
  if (!value || typeof value !== "object") return null;
  const summary = record(value);
  return {
    available: asBoolean(summary.available),
    accidentCount: asNumber(summary.accidentCount),
    ownAccidentCount: asNumber(summary.ownAccidentCount),
    otherAccidentCount: asNumber(summary.otherAccidentCount),
    ownerChangeCount: asNumber(summary.ownerChangeCount),
    ownAccidentCostKrw: asNumber(summary.ownAccidentCostKrw),
    otherAccidentCostKrw: asNumber(summary.otherAccidentCostKrw),
    totalLossCount: asNumber(summary.totalLossCount),
    floodTotalLossCount: asNumber(summary.floodTotalLossCount),
    floodPartLossCount: asNumber(summary.floodPartLossCount),
    theftCount: asNumber(summary.theftCount),
    loanCount: asNumber(summary.loanCount),
  };
}

export async function loadCatalogCars(): Promise<CatalogCar[]> {
  const client = createSupabasePublicServerClient();
  const { data, error } = await client
    .from("catalog_vehicles")
    .select("*")
    .order("model_year", { ascending: false })
    .order("published_at", { ascending: false })
    .limit(100);

  if (error) throw new Error(`Catalog request failed: ${error.message}`);

  return (data ?? []).flatMap((row) => {
    if (
      !row.id ||
      !row.source_listing_id ||
      !row.manufacturer ||
      !row.model ||
      !row.model_year ||
      row.mileage_km === null ||
      row.price_krw === null ||
      !row.fuel_type ||
      !row.source_url
    ) {
      return [];
    }
    const calculation = calculateBelarusPrice({
      priceKrw: Number(row.price_krw),
      engineCc: row.engine_cc,
      firstRegistrationDate: row.first_registration_date,
      fuelType: row.fuel_type,
      preferential: true,
    });
    const images = row.image_urls ?? [];
    if (!images.length) return [];

    return [
      {
        id: row.id,
        sourceListingId: row.source_listing_id,
        brand: row.manufacturer,
        model: row.model,
        trim: row.trim ?? row.generation ?? "Комплектация не указана",
        generation: row.generation,
        year: row.model_year,
        registrationDate: row.first_registration_date,
        mileage: row.mileage_km,
        engine: row.engine_cc ? `${(row.engine_cc / 1000).toFixed(1)} л` : "Электро",
        engineCc: row.engine_cc,
        fuel: fuelName(row.fuel_type),
        sourceFuel: row.fuel_type,
        drive: row.drive_type ?? "Не указан",
        bodyType: row.body_type,
        color: row.exterior_color,
        transmission: row.transmission,
        vinMasked: row.vin_masked,
        price: calculation.totalUsd,
        sourcePriceKrw: Number(row.price_krw),
        location: locationName(row.location),
        images,
        sourceUrl: row.source_url,
        sourceUpdatedAt: row.source_updated_at,
        lastSeenAt: row.last_seen_at,
        status: "Проверено" as const,
        calculation,
        options: parseOptions(row.report_options),
        inspection: parseInspection(row.inspection_summary),
        accidents: parseAccidents(row.accident_summary),
        reportStatus: row.report_status,
        reportFetchedAt: row.report_fetched_at,
      },
    ];
  });
}
