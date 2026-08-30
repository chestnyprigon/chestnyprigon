import type { EncarBundle } from "./types";

export function canonicalSourceId(bundle: EncarBundle) {
  return String(bundle.detail.vehicleId ?? bundle.search.Id);
}

export function sourceIdentifiers(bundle: EncarBundle) {
  const identifiers = [
    { value: canonicalSourceId(bundle), type: "canonical" as const },
    { value: String(bundle.search.Id), type: "search" as const },
    { value: bundle.detail.vehicleNo, type: "detail" as const },
  ];
  const unique = new Map<string, (typeof identifiers)[number]>();
  for (const identifier of identifiers) {
    if (identifier.value && identifier.value !== "undefined" && !unique.has(identifier.value)) {
      unique.set(identifier.value, identifier);
    }
  }
  return [...unique.values()];
}
