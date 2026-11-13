import "server-only";

import { z } from "zod";

const componentSchema = z.record(z.string(), z.number().nullable());
const rateSchema = z.object({
  rubPerUnit: z.record(z.string(), z.number().positive()),
  effectiveDate: z.string(),
  fetchedAt: z.string(),
  source: z.string(),
});

export const tksResultSchema = z.object({
  engine: z.literal("koredigital-tks"),
  rulesVersion: z.string(),
  calculationDate: z.string(),
  estimatedClearanceDate: z.string(),
  vehicle: z.object({
    price: z.object({ amount: z.number(), currency: z.enum(["RUB", "KRW", "USD", "EUR", "KZT"]) }),
    engineCc: z.number().nullable(),
    powertrain: z.string(),
    hybridTopology: z.string().nullable(),
  }),
  age: z.object({ yearsAtClearance: z.number(), referenceDate: z.string(), basis: z.string(), assumed: z.boolean() }),
  power: z.object({
    calculationPowerKw: z.number(), calculationBasis: z.string(), calculationRule: z.string(),
    confidence: z.enum(["CONFIRMED", "PROBABLE", "ESTIMATED"]), sourceRef: z.string(), researchRef: z.string().nullable(),
    components: componentSchema, hybridDvsAboveElectric30Min: z.boolean().nullable(),
  }),
  customsValueRub: z.number(), dutyRub: z.number(), exciseRub: z.number(), vatRub: z.number(),
  recyclingFeeRub: z.number(), customsProcessingFeeRub: z.number(), officialSubtotalRub: z.number(),
  rates: rateSchema,
  powerContext: z.object({
    approvalState: z.string().optional(),
    resolutionClass: z.string().optional(),
    sources: z.array(z.unknown()).optional(),
    measurements: z.array(z.unknown()).optional(),
  }).optional(),
  disclaimer: z.string(),
});

export type VehiclePowerTksResult = z.infer<typeof tksResultSchema>;

export type VehiclePowerTksInput = {
  correlation?: string;
  vehicle: {
    price: { amount: number; currency: "RUB" | "KRW" | "USD" | "EUR" | "KZT" };
    firstRegistration?: { year: number; month?: number; day?: number };
    modelYear?: number;
    engineCc: number | null;
    powertrain: "ice" | "electric" | "hybrid_parallel" | "hybrid_sequential" | "hybrid_phev";
    hybridTopology?: "parallel" | "sequential";
    power?: {
      calculationPowerKw: number;
      basis: "combustion_rated" | "electric_peak" | "electric_30min" | "system_combined";
      confidence: "CONFIRMED" | "PROBABLE" | "ESTIMATED";
      sourceRef: string;
      researchRef?: string;
      combustionPowerKw?: number;
      electricPeakPowerKw?: number;
      electric30MinPowerKw?: number;
      systemCombinedPowerKw?: number;
      hybridDvsAboveElectric30Min?: boolean;
    };
    powerRecord?: Record<string, unknown>;
  };
  calculationDate?: string;
  clearanceDays?: number;
};

export const powerRecordSchema = z.object({
  contractVersion: z.literal("power-record-v1"),
  propulsion: z.enum(["ice", "electric", "hybrid_parallel", "hybrid_sequential", "hybrid_phev"]),
  measurements: z.array(z.object({
    basis: z.enum(["combustion_rated", "electric_peak", "electric_30min", "system_combined"]),
    kw: z.number().positive(),
    original: z.object({ value: z.number().positive(), unit: z.enum(["kW", "PS", "hp"]) }),
  })),
  resolutionClass: z.enum(["CONFIRMED", "PROBABLE", "ESTIMATED", "INSUFFICIENT_DATA"]),
  rationale: z.string(),
  approvalState: z.enum(["draft", "provisional", "approved", "retired", "revoked"]),
  origin: z.object({ project: z.string(), recordId: z.string(), revision: z.string() }),
  configurationFingerprint: z.string(),
  sources: z.array(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough();

const resolveResultSchema = z.object({
  status: z.enum(["RESOLVED", "REVIEW_REQUIRED", "NOT_FOUND"]),
  resolutionClass: z.enum(["CONFIRMED", "PROBABLE", "ESTIMATED", "INSUFFICIENT_DATA"]),
  record: powerRecordSchema.optional(),
  referenceVersion: z.string(),
}).passthrough();

export type VehiclePowerResolveInput = {
  brand: string;
  model: string;
  generation?: string;
  trim?: string;
  fuelType?: string;
  driveType?: string;
  market?: string;
  year?: number;
  firstRegistrationYear?: number;
  engineCc?: number;
  electricPeakKw?: number;
  combustionKw?: number;
  powertrain?: "ice" | "electric" | "hybrid_parallel" | "hybrid_sequential" | "hybrid_phev";
  hybridTopology?: "parallel" | "sequential";
  researchMode?: "catalog_only" | "research";
  correlation?: { source?: string; sourceListingId?: string; masterId?: string };
};

export type VehiclePowerResolveResult = z.infer<typeof resolveResultSchema>;

function apiBaseUrl() {
  const value = process.env.VEHICLE_POWER_API_BASE_URL?.trim();
  if (!value) throw new Error("VEHICLE_POWER_API_BASE_URL is not configured");
  return value.replace(/\/+$/, "");
}

/** Resolve the closest usable configuration through the separate power:resolve scope. */
export async function resolveVehiclePower(input: VehiclePowerResolveInput): Promise<VehiclePowerResolveResult> {
  const token = process.env.VEHICLE_POWER_RESOLVE_TOKEN?.trim();
  if (!token) throw new Error("VEHICLE_POWER_RESOLVE_TOKEN is not configured");
  const response = await fetch(`${apiBaseUrl()}/v1/power/resolve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Vehicle Power resolve request failed (${response.status})`);
  const parsed = resolveResultSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Vehicle Power resolve response did not match the expected contract");
  return parsed.data;
}

/** Server-only call. The bearer and API response are never exposed to browser code. */
export async function calculateRussiaTks(input: VehiclePowerTksInput): Promise<VehiclePowerTksResult> {
  const token = process.env.VEHICLE_POWER_TKS_TOKEN?.trim();
  if (!token) throw new Error("VEHICLE_POWER_TKS_TOKEN is not configured");

  const response = await fetch(`${apiBaseUrl()}/v1/tks/calculate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    // Do not include response body: upstream validation/errors can contain request data.
    throw new Error(`Vehicle Power TKS request failed (${response.status})`);
  }
  const parsed = tksResultSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Vehicle Power TKS response did not match the expected contract");
  return parsed.data;
}

function candidateScore(candidate: Record<string, unknown>, input: VehiclePowerResolveInput) {
  const matched = candidate.matchedCharacteristics && typeof candidate.matchedCharacteristics === "object"
    ? candidate.matchedCharacteristics as Record<string, unknown>
    : {};
  let score = 0;
  if (typeof matched.generation === "string" && input.generation && matched.generation === input.generation) score += 8;
  if (typeof matched.driveType === "string" && input.driveType && matched.driveType === input.driveType) score += 4;
  if (typeof matched.engineCc === "number" && input.engineCc && matched.engineCc === input.engineCc) score += 4;
  if (typeof matched.year === "number" && input.year && matched.year === input.year) score += 2;
  if (typeof matched.fuelType === "string" && input.fuelType && matched.fuelType === input.fuelType) score += 2;
  return score;
}

/** Returns the closest source-backed PowerRecord; equal resolver candidates keep API order. */
export async function resolveBestPowerRecord(input: VehiclePowerResolveInput) {
  const result = await resolveVehiclePower(input);
  if (result.record && result.record.resolutionClass !== "INSUFFICIENT_DATA") return result.record;
  const options = Array.isArray(result.selectionCandidates) ? result.selectionCandidates : [];
  const candidates = options.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .sort((left, right) => candidateScore(right, input) - candidateScore(left, input));
  for (const candidate of candidates) {
    const parsed = powerRecordSchema.safeParse(candidate.record);
    if (parsed.success && parsed.data.resolutionClass !== "INSUFFICIENT_DATA") return parsed.data;
  }
  throw new Error("No usable preliminary power record was returned by Vehicle Power");
}

export async function calculateRussiaTksWithPowerResolve(
  input: Omit<VehiclePowerTksInput, "vehicle"> & { vehicle: Omit<VehiclePowerTksInput["vehicle"], "power" | "powerRecord"> },
  resolveInput: VehiclePowerResolveInput,
) {
  const powerRecord = await resolveBestPowerRecord(resolveInput);
  return calculateRussiaTks({ ...input, vehicle: { ...input.vehicle, powerRecord } });
}
