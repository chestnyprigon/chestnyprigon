import "server-only";

import { createHash } from "node:crypto";
import { calculateRussiaKoreaCommercial, calculateRussiaEuropeCommercial, combineRussiaPrice } from "@/lib/pricing/russia-pricing";
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

const POWER_RESOLUTION_VERSION = "power-resolution-v1";
type EstimatedPower = NonNullable<VehiclePowerTksInput["vehicle"]["power"]>;
export type PersistedPowerResolution = {
  version: typeof POWER_RESOLUTION_VERSION;
  fingerprint: string;
  resolvedAt: string;
  status: "source_record" | "source_power" | "estimated_fallback" | "legacy_snapshot";
  powerRecord: Record<string, unknown> | null;
  power: EstimatedPower | null;
};

function powerResolutionFingerprint(vehicle: CatalogVehicle) {
  const inputs = {
    version: POWER_RESOLUTION_VERSION,
    source: vehicle.source,
    sourceId: vehicle.sourceId,
    brand: vehicle.brand.trim().toLowerCase(),
    model: vehicle.model.trim().toLowerCase(),
    generation: vehicle.generation?.trim().toLowerCase() ?? null,
    trim: vehicle.trim?.trim().toLowerCase() ?? null,
    year: vehicle.year ?? null,
    firstRegistration: vehicle.firstRegistration ?? null,
    engineCc: vehicle.engineCc ?? null,
    fuelType: vehicle.fuelType?.trim().toLowerCase() ?? null,
    driveType: vehicle.driveType?.trim().toLowerCase() ?? null,
    powerKw: vehicle.powerKw ?? null,
    powerPs: vehicle.powerPs ?? null,
    electric30MinKw: vehicle.electric30MinKw ?? null,
    electricPeakKw: vehicle.electricPeakKw ?? null,
    enginePowerKw: vehicle.enginePowerKw ?? null,
    systemCombinedPowerKw: vehicle.systemCombinedPowerKw ?? null,
    powerBasis: vehicle.powerBasis ?? null,
    powerConfidence: vehicle.powerConfidence ?? null,
    powerSourceRef: vehicle.powerSourceRef ?? null,
  };
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

function validCachedPowerResolution(value: unknown, vehicle: CatalogVehicle, fingerprint: string): value is PersistedPowerResolution {
  if (!value || typeof value !== "object") return false;
  const cache = value as Partial<PersistedPowerResolution>;
  return cache.version === POWER_RESOLUTION_VERSION
    && cache.fingerprint === fingerprint
    && typeof cache.resolvedAt === "string"
    && Number.isFinite(Date.parse(cache.resolvedAt))
    && ["source_record", "source_power", "estimated_fallback", "legacy_snapshot"].includes(cache.status ?? "")
    && (cache.status !== "estimated_fallback" || Date.now() - Date.parse(cache.resolvedAt) < 7 * 24 * 60 * 60 * 1_000)
    && (cache.status === "source_record"
      ? Boolean(cache.powerRecord && typeof cache.powerRecord === "object"
        && cache.powerRecord.contractVersion === "power-record-v1"
        && cache.powerRecord.propulsion === powertrainFor(vehicle.fuelType)
        && cache.power === null)
      : Boolean(cache.powerRecord === null && cache.power && typeof cache.power === "object"
        && Number.isFinite(cache.power.calculationPowerKw) && cache.power.calculationPowerKw > 0));
}

/** Rebuilds the reusable power input from a saved TKS snapshot without contacting Vehicle Power. */
export function powerResolutionFromSavedCalculation(vehicle: CatalogVehicle, calculation: unknown): PersistedPowerResolution | null {
  if (!calculation || typeof calculation !== "object") return null;
  const result = calculation as { power?: Record<string, unknown> };
  const savedPower = result.power;
  if (!savedPower || typeof savedPower !== "object") return null;
  const calculationPowerKw = Number(savedPower.calculationPowerKw);
  if (!Number.isFinite(calculationPowerKw) || calculationPowerKw <= 0) return null;
  const allowedBases = ["combustion_rated", "electric_peak", "electric_30min", "system_combined"] as const;
  const basis = allowedBases.includes(savedPower.calculationBasis as typeof allowedBases[number])
    ? savedPower.calculationBasis as EstimatedPower["basis"]
    : powertrainFor(vehicle.fuelType) === "electric" || powertrainFor(vehicle.fuelType) === "hybrid_sequential"
      ? "electric_30min"
      : powertrainFor(vehicle.fuelType) === "hybrid_parallel" || powertrainFor(vehicle.fuelType) === "hybrid_phev"
        ? "system_combined"
        : "combustion_rated";
  const confidence = ["CONFIRMED", "PROBABLE", "ESTIMATED"].includes(String(savedPower.confidence))
    ? savedPower.confidence as EstimatedPower["confidence"]
    : "ESTIMATED";
  const sourceRef = typeof savedPower.sourceRef === "string"
    ? savedPower.sourceRef.slice(0, 480)
    : `${vehicle.source}:${vehicle.sourceId}:saved-price-snapshot`;
  const components = savedPower.components && typeof savedPower.components === "object"
    ? savedPower.components as Record<string, unknown>
    : {};
  const component = (name: string) => {
    const value = Number(components[name]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const combustionPowerKw = component("combustionPowerKw");
  const electric30MinPowerKw = component("electric30MinPowerKw");
  const power: EstimatedPower = {
    calculationPowerKw, basis, confidence, sourceRef,
    ...(typeof savedPower.researchRef === "string" ? { researchRef: savedPower.researchRef.slice(0, 480) } : {}),
    ...(combustionPowerKw ? { combustionPowerKw } : {}),
    ...(component("electricPeakPowerKw") ? { electricPeakPowerKw: component("electricPeakPowerKw") } : {}),
    ...(electric30MinPowerKw ? { electric30MinPowerKw } : {}),
    ...(component("systemCombinedPowerKw") ? { systemCombinedPowerKw: component("systemCombinedPowerKw") } : {}),
    ...(combustionPowerKw && electric30MinPowerKw
      ? { hybridDvsAboveElectric30Min: combustionPowerKw > electric30MinPowerKw }
      : {}),
  };
  return {
    version: POWER_RESOLUTION_VERSION,
    fingerprint: powerResolutionFingerprint(vehicle),
    resolvedAt: new Date().toISOString(),
    status: "legacy_snapshot",
    powerRecord: null,
    power,
  };
}

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

async function resolveOrEstimatePower(vehicle: CatalogVehicle, cached?: unknown) {
  const fingerprint = powerResolutionFingerprint(vehicle);
  if (validCachedPowerResolution(cached, vehicle, fingerprint)) {
    return { power: cached.power ?? undefined, powerRecord: cached.powerRecord ?? undefined, powerResolution: cached };
  }
  const powertrain = powertrainFor(vehicle.fuelType);
  const hasDirectPower = powertrain === "ice"
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
      if (record.propulsion === powertrain && record.resolutionClass !== "INSUFFICIENT_DATA") {
        return {
          powerRecord: record,
          powerResolution: {
            version: POWER_RESOLUTION_VERSION, fingerprint, resolvedAt: new Date().toISOString(),
            status: "source_record" as const, powerRecord: record as Record<string, unknown>, power: null,
          } as PersistedPowerResolution,
        };
      }
    } catch {
      // Keep the estimate path available if the source resolver is unavailable.
    }
  }
  const power = estimatedPower(vehicle);
  return {
    power,
    powerResolution: {
      version: POWER_RESOLUTION_VERSION, fingerprint, resolvedAt: new Date().toISOString(),
      status: hasDirectPower ? "source_power" as const : "estimated_fallback" as const,
      powerRecord: null, power,
    } as PersistedPowerResolution,
  };
}

async function calculateUncached(
  vehicle: CatalogVehicle,
  cachedPowerResolution?: unknown,
  onPowerResolved?: (powerResolution: PersistedPowerResolution) => Promise<void>,
) {
  const { power, powerRecord, powerResolution } = await resolveOrEstimatePower(vehicle, cachedPowerResolution);
  if (onPowerResolved) await onPowerResolved(powerResolution);
  const chosenPowertrain = (powerRecord?.propulsion as VehiclePowerTksInput["vehicle"]["powertrain"] | undefined)
    ?? powertrainFor(vehicle.fuelType)!;
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
  return { calculation: combineRussiaPrice(commercial, tks), powerResolution };
}

/** Worker path: reuse a matching persisted power resolution and return it for storage. */
export function calculateRussiaVehicleSnapshotFresh(
  vehicle: CatalogVehicle,
  cachedPowerResolution?: unknown,
  onPowerResolved?: (powerResolution: PersistedPowerResolution) => Promise<void>,
) {
  return calculateUncached(vehicle, cachedPowerResolution, onPowerResolved);
}

export type { CatalogVehicle };
