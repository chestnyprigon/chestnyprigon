import "server-only";

import { unstable_cache } from "next/cache";
import { calculateRussiaKoreaCommercial, calculateRussiaEuropeCommercial, combineRussiaPrice, type RussiaPriceResult } from "@/lib/pricing/russia-pricing";
import { calculateRussiaTks, resolveBestPowerRecord, type VehiclePowerResolveInput, type VehiclePowerTksInput } from "@/lib/pricing/vehicle-power-tks";

type CatalogVehicle = {
  source: "korea" | "europe";
  sourceId: string;
  brand: string;
  model: string;
  generation?: string | null;
  trim?: string | null;
  year?: number | null;
  firstRegistration?: string | null;
  engineCc?: number | null;
  fuelType?: string | null;
  driveType?: string | null;
  price: number;
  currency: "KRW" | "EUR";
  powerKw?: number | null;
  powerPs?: number | null;
  electric30MinKw?: number | null;
  electricPeakKw?: number | null;
  enginePowerKw?: number | null;
  systemCombinedPowerKw?: number | null;
  powerBasis?: string | null;
  powerConfidence?: string | null;
  powerSourceRef?: string | null;
  krwPerUsd?: number;
};

function powertrainFor(fuelType: string | null | undefined): VehiclePowerResolveInput["powertrain"] {
  const fuel = (fuelType ?? "").toLowerCase();
  if (/phev|plug[ -]?in|플러그인/u.test(fuel)) return "hybrid_phev";
  if (/hybrid|hev|하이브리드|가솔린\s*\+\s*전기|디젤\s*\+\s*전기/u.test(fuel)) return /series|sequential|range[ -]?extender|직렬/u.test(fuel) ? "hybrid_sequential" : "hybrid_parallel";
  if (/electric|электро|전기/u.test(fuel)) return "electric";
  return "ice";
}

function modelYearRegistration(date: string | null | undefined, year: number | null | undefined) {
  const match = date?.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (match) return { firstRegistration: { year: Number(match[1]), ...(match[2] ? { month: Number(match[2]) } : {}), ...(match[3] ? { day: Number(match[3]) } : {}) }, modelYear: year ?? Number(match[1]) };
  return { modelYear: year ?? undefined };
}

function estimatedPower(vehicle: CatalogVehicle): NonNullable<VehiclePowerTksInput["vehicle"]["power"]> {
  const propulsion = powertrainFor(vehicle.fuelType);
  const confidence = ["CONFIRMED", "PROBABLE", "ESTIMATED"].includes(vehicle.powerConfidence?.toUpperCase() ?? "")
    ? vehicle.powerConfidence!.toUpperCase() as "CONFIRMED" | "PROBABLE" | "ESTIMATED"
    : "ESTIMATED";
  const sourceRef = `${vehicle.source}:${vehicle.sourceId}:${vehicle.powerSourceRef ?? "preliminary-power-estimate"}`.slice(0, 480);
  const listingPowerKw = vehicle.powerKw ?? vehicle.enginePowerKw ?? vehicle.systemCombinedPowerKw ?? (vehicle.powerPs && vehicle.powerPs > 0 ? vehicle.powerPs / 1.3596216173 : null);
  const engineKw = vehicle.enginePowerKw ?? (vehicle.powerBasis === "combustion_rated" ? vehicle.powerKw : null);
  const fallbackKw = Math.min(500, Math.max(40, (vehicle.engineCc ?? 1800) * 0.055));
  if (propulsion === "electric") {
    const p30 = vehicle.electric30MinKw ?? (vehicle.electricPeakKw ? vehicle.electricPeakKw * 0.45 : listingPowerKw ? listingPowerKw * 0.45 : fallbackKw);
    return { calculationPowerKw: p30, basis: "electric_30min", confidence, sourceRef, electric30MinPowerKw: p30, ...(vehicle.electricPeakKw ? { electricPeakPowerKw: vehicle.electricPeakKw } : {}) };
  }
  if (propulsion === "hybrid_parallel" || propulsion === "hybrid_phev") {
    const combined = listingPowerKw ?? fallbackKw;
    const combustion = engineKw ?? combined * 0.75;
    const p30 = vehicle.electric30MinKw ?? (vehicle.electricPeakKw ? vehicle.electricPeakKw * 0.45 : combined * 0.1125);
    return { calculationPowerKw: combustion + p30, basis: "system_combined", confidence, sourceRef, combustionPowerKw: combustion, electric30MinPowerKw: p30, ...(vehicle.electricPeakKw ? { electricPeakPowerKw: vehicle.electricPeakKw } : {}), hybridDvsAboveElectric30Min: combustion > p30 };
  }
  if (propulsion === "hybrid_sequential") {
    const p30 = vehicle.electric30MinKw ?? (vehicle.electricPeakKw ? vehicle.electricPeakKw * 0.45 : listingPowerKw ? listingPowerKw * 0.45 : fallbackKw);
    return { calculationPowerKw: p30, basis: "electric_30min", confidence, sourceRef, electric30MinPowerKw: p30 };
  }
  const combustion = engineKw ?? listingPowerKw ?? fallbackKw;
  return { calculationPowerKw: combustion, basis: "combustion_rated", confidence, sourceRef, combustionPowerKw: combustion };
}

async function resolveOrEstimatePower(vehicle: CatalogVehicle) {
  const powertrain = powertrainFor(vehicle.fuelType);
  const hasDirectPower = vehicle.source === "korea" && powertrain === "ice"
    ? Boolean(vehicle.enginePowerKw || vehicle.powerBasis === "combustion_rated" && vehicle.powerKw || vehicle.powerPs)
    : powertrain === "electric"
      ? Boolean(vehicle.electric30MinKw)
      : false;
  if (!hasDirectPower) {
    try {
      const resolveInput: VehiclePowerResolveInput = {
        brand: vehicle.brand,
        model: vehicle.model,
        ...(vehicle.generation ? { generation: vehicle.generation } : {}),
        ...(vehicle.trim ? { trim: vehicle.trim } : {}),
        ...(vehicle.year ? { year: vehicle.year } : {}),
        ...(vehicle.engineCc ? { engineCc: vehicle.engineCc } : {}),
        ...(vehicle.fuelType ? { fuelType: vehicle.fuelType } : {}),
        ...(vehicle.driveType ? { driveType: vehicle.driveType } : {}),
        market: vehicle.source === "korea" ? "South Korea" : "Europe",
        powertrain,
        ...(powertrain === "hybrid_phev" ? { hybridTopology: "parallel" as const } : {}),
        correlation: { source: vehicle.source, sourceListingId: vehicle.sourceId },
      };
      const record = await resolveBestPowerRecord(resolveInput);
      if (record.propulsion === powertrain && record.resolutionClass !== "INSUFFICIENT_DATA") return { powerRecord: record };
    } catch {
      // Keep the estimate path available if the source resolver is unavailable.
    }
  }
  return { power: estimatedPower(vehicle) };
}

async function calculateUncached(vehicle: CatalogVehicle): Promise<RussiaPriceResult> {
  const { power, powerRecord } = await resolveOrEstimatePower(vehicle);
  const chosenPowertrain = powerRecord?.propulsion ?? powertrainFor(vehicle.fuelType)!;
  const tksVehicle: VehiclePowerTksInput["vehicle"] = {
    price: { amount: vehicle.price, currency: vehicle.currency },
    ...modelYearRegistration(vehicle.firstRegistration, vehicle.year),
    engineCc: chosenPowertrain === "electric" ? null : vehicle.engineCc ?? 1800,
    powertrain: chosenPowertrain,
    ...(chosenPowertrain === "hybrid_phev" ? { hybridTopology: "parallel" as const } : {}),
    ...(power ? { power } : {}),
    ...(powerRecord ? { powerRecord } : {}),
  };
  const tks = await calculateRussiaTks({ correlation: `${vehicle.source}:${vehicle.sourceId}`, vehicle: tksVehicle });
  const rates = tks.rates.rubPerUnit;
  const commercial = vehicle.currency === "KRW"
    ? calculateRussiaKoreaCommercial({ priceKrw: vehicle.price, krwPerUsd: vehicle.krwPerUsd ?? 1_397, rubPerUsd: rates.USD!, rubPerEur: rates.EUR! })
    : calculateRussiaEuropeCommercial({ netPriceEur: vehicle.price, rubPerEur: rates.EUR! });
  return combineRussiaPrice(commercial, tks);
}

/** Fresh calculation used only by the explicit price refresh control. */
export function calculateRussiaVehiclePriceFresh(vehicle: CatalogVehicle) {
  return calculateUncached(vehicle);
}

const cachedCalculation = unstable_cache(calculateUncached, ["russia-vehicle-price-v1"], { revalidate: 900 });

export function calculateRussiaVehiclePrice(vehicle: CatalogVehicle) {
  return cachedCalculation(vehicle);
}

export async function calculateRussiaVehiclePrices(vehicles: CatalogVehicle[], concurrency = 4) {
  const results: Array<RussiaPriceResult | null> = Array.from({ length: vehicles.length }, () => null);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), vehicles.length) }, async () => {
    while (nextIndex < vehicles.length) {
      const index = nextIndex++;
      try { results[index] = await cachedCalculation(vehicles[index]!); }
      catch { results[index] = null; }
    }
  });
  await Promise.all(workers);
  return results;
}

export type { CatalogVehicle };
