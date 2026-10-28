import type { MobileDeFacets } from "./types";

// Values are API identifiers. In particular, 116d and 116D must stay distinct.
const fields = {
  make: "makes",
  model: "models",
  fuel_type: "fuel_types",
  transmission: "transmissions",
  body_type: "body_types",
} as const;

export function normalizeMobileDeFacets(payload: unknown): MobileDeFacets {
  if (!payload || typeof payload !== "object") throw new Error("Invalid facets response");
  const data = "data" in payload ? payload.data : payload;
  if (!data || typeof data !== "object") throw new Error("Invalid facets data");
  const record = data as Record<string, unknown>;
  const result: MobileDeFacets = {};
  for (const [source, target] of Object.entries(fields)) {
    const entries = record[source];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) throw new Error(`Invalid facet: ${source}`);
    result[target as typeof fields[keyof typeof fields]] = [...new Set(entries.map(entry => {
      if (!entry || typeof entry !== "object" || typeof entry.value !== "string") {
        throw new Error(`Invalid facet value: ${source}`);
      }
      return entry.value as string;
    }))];
  }
  if (record.ranges !== undefined) {
    if (!record.ranges || typeof record.ranges !== "object" || Array.isArray(record.ranges)) throw new Error("Invalid facet ranges");
    result.ranges = record.ranges as MobileDeFacets["ranges"];
  }
  if (!Object.keys(result).length) throw new Error("Empty facets schema");
  return result;
}
