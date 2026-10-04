export function encarOptionsUrl(sourceListingId: string) {
  const url = new URL("https://api.encar.com/v1/readside/vehicles");
  url.searchParams.set("vehicleIds", sourceListingId);
  url.searchParams.set("include", "OPTIONS");
  return url;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function extractStandardOptionCodes(payload: unknown, expectedCanonicalId: string) {
  const detail = Array.isArray(payload) ? record(payload[0]) : record(payload);
  if (!Object.keys(detail).length) throw new Error("source_listing_unavailable");
  if (String(detail.vehicleId ?? "") !== expectedCanonicalId) throw new Error("canonical_id_mismatch");
  const standard = record(detail.options).standard;
  if (!Array.isArray(standard)) throw new Error("standard_options_missing");
  return [...new Set(standard
    .map((code) => typeof code === "string" || typeof code === "number" ? String(code).trim() : "")
    .filter(Boolean))];
}
