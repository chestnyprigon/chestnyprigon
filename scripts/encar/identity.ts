import type { EncarBundle } from "./types";

export function canonicalSourceId(bundle: EncarBundle) {
  return String(bundle.detail.vehicleId ?? bundle.search.Id);
}
