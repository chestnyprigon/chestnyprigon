type Measurement = { basis?: unknown; kw?: unknown; original?: { value?: unknown; unit?: unknown } };
export type PowerRecord = Record<string, unknown> & {
  contractVersion?: unknown;
  propulsion?: unknown;
  measurements?: unknown;
  resolutionClass?: unknown;
  sources?: unknown;
  origin?: unknown;
};

export type VehiclePowerFields = {
  engine_power_ps: number | null;
  engine_power_kw: number | null;
  electric_motor_peak_kw: number | null;
  electric_30min_kw: number | null;
  system_combined_power_ps: number | null;
  system_combined_power_kw: number | null;
  power_basis: string;
  power_source_type: "vehicle_power";
  power_source_url: string;
  power_confidence: "confirmed" | "probable" | "estimated";
  power_match_method: string;
  power_checked_at: string;
};

const kw = (record: PowerRecord, basis: string) => {
  const measurements = Array.isArray(record.measurements) ? record.measurements as Measurement[] : [];
  const value = measurements.find((item) => item?.basis === basis)?.kw;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
};
const evidenceUrl = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  return [source.url, source.sourceUrl, source.uri]
    .find((item) => typeof item === "string" && /^https?:\/\//i.test(item)) as string | undefined;
};

export function vehiclePowerRecordIssue(value: unknown): string | null {
  if (!value || typeof value !== "object") return "power_record_missing";
  const record = value as PowerRecord;
  if (record.contractVersion !== "power-record-v1") return "power_record_contract_invalid";
  if (!["ice", "electric", "hybrid_parallel", "hybrid_sequential", "hybrid_phev"].includes(String(record.propulsion))) return "powertrain_unknown";
  if (!["CONFIRMED", "PROBABLE", "ESTIMATED"].includes(String(record.resolutionClass))) return "resolution_class_not_publishable";
  if (!Array.isArray(record.sources) || record.sources.length === 0) return "source_evidence_missing";
  const sources = record.sources as Array<Record<string, unknown>>;
  if (!sources.some((source) => evidenceUrl(source))) return "source_url_missing";
  const propulsion = String(record.propulsion);
  if (propulsion === "ice" && kw(record, "combustion_rated") === null) return "combustion_power_missing";
  if ((propulsion === "electric" || propulsion === "hybrid_sequential") && kw(record, "electric_30min") === null) return "electric_30min_power_missing";
  if ((propulsion === "hybrid_parallel" || propulsion === "hybrid_phev")
    && (kw(record, "combustion_rated") === null || kw(record, "electric_30min") === null)) return "hybrid_power_components_missing";
  return null;
}

export function vehiclePowerFields(value: unknown, checkedAt = new Date().toISOString()): VehiclePowerFields {
  const issue = vehiclePowerRecordIssue(value);
  if (issue) throw new Error(issue);
  const record = value as PowerRecord;
  const combustion = kw(record, "combustion_rated");
  const electricPeak = kw(record, "electric_peak");
  const electric30 = kw(record, "electric_30min");
  const combined = kw(record, "system_combined");
  const propulsion = String(record.propulsion);
  const basis = propulsion === "ice" || propulsion === "hybrid_parallel" || propulsion === "hybrid_phev" ? "combustion_rated" : "electric_30min";
  const sources = record.sources as Array<Record<string, unknown>>;
  const sourceUrl = String(sources.map(evidenceUrl).find(Boolean));
  const resolutionClass = String(record.resolutionClass).toLowerCase() as VehiclePowerFields["power_confidence"];
  const ps = (value: number | null) => value === null ? null : Number((value * 1.3596216173).toFixed(2));
  return {
    engine_power_ps: ps(combustion), engine_power_kw: combustion,
    electric_motor_peak_kw: electricPeak, electric_30min_kw: electric30,
    system_combined_power_ps: ps(combined), system_combined_power_kw: combined,
    power_basis: basis, power_source_type: "vehicle_power", power_source_url: sourceUrl,
    power_confidence: resolutionClass, power_match_method: "vehicle_power_configuration_resolver", power_checked_at: checkedAt,
  };
}
