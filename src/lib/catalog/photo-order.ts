import { encarPhotoUrl } from "../encar/images";
import { encarCoverScore } from "../encar/photo-cover";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Select the cover without treating the unordered report photoGroups as a gallery order. */
export function orderCatalogImages(value: unknown, images: string[]) {
  const summary = record(value);
  const types = new Map<string, string>();
  for (const item of Array.isArray(summary.photoGroups) ? summary.photoGroups : []) {
    const photo = record(item);
    if (typeof photo.url === "string" && typeof photo.group === "string") {
      types.set(encarPhotoUrl(photo.url), photo.group);
    }
  }
  let coverIndex = 0;
  let coverScore = -1;
  images.forEach((url, index) => {
    const score = encarCoverScore(url, types.get(encarPhotoUrl(url)));
    if (score > coverScore) {
      coverIndex = index;
      coverScore = score;
    }
  });
  if (coverIndex === 0) return images;
  return [images[coverIndex], ...images.slice(0, coverIndex), ...images.slice(coverIndex + 1)];
}
