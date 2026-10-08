import { publicationGate } from "./publication-gate";
import type { EncarBundle, EncarDetail, EncarSearchListing } from "./types";

const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};

export function stagingPublicationInput(row: Record<string, unknown>) {
  const payload = obj(row.encar_payload);
  const snapshot = obj(row.candidate_snapshot);
  const search = Object.keys(obj(payload.search)).length ? obj(payload.search) : {
    ...snapshot,
    Id: snapshot.Id ?? snapshot.encarId,
    Manufacturer: snapshot.Manufacturer ?? snapshot.manufacturer,
    Model: snapshot.Model ?? snapshot.model,
    FormYear: snapshot.FormYear ?? snapshot.modelYear,
    Mileage: snapshot.Mileage ?? snapshot.mileageKm,
    Price: snapshot.Price ?? (typeof snapshot.priceKrw === "number" ? snapshot.priceKrw / 10000 : undefined),
  };
  const bundle: EncarBundle = { fetchedAt: String(payload.fetchedAt ?? row.updated_at ?? ""), search: search as EncarSearchListing, detail: obj(payload.detail) as EncarDetail };
  return { bundle, queueId: String(row.source_listing_id ?? ""), sourceUrl: String(row.source_url ?? ""), snapshot: { ...search, ...snapshot } as EncarSearchListing,
    identifiers: obj(payload.identifiers), images: Array.isArray(row.image_urls) ? row.image_urls : [],
    endpointStatus: obj(payload.endpointStatus), rawReports: obj(payload.rawReports), options: payload.choiceOptions };
}

export function screenStaging(row: Record<string, unknown>) {
  const input = stagingPublicationInput(row);
  const result = publicationGate(input);
  return { ...result, input };
}
