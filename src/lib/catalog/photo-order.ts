import { encarPhotoUrl } from "../encar/images";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Restore the original Encar gallery ordering saved in a vehicle report. */
export function orderImagesByReport(value: unknown, images: string[]) {
  const summary = record(value);
  if (!Array.isArray(summary.photoGroups)) return images;
  const sourceOrder = new Map<string, number>();
  for (const [index, item] of summary.photoGroups.entries()) {
    const url = record(item).url;
    if (typeof url !== "string" || !url.trim()) continue;
    const normalized = encarPhotoUrl(url);
    if (!sourceOrder.has(normalized)) sourceOrder.set(normalized, index);
  }
  if (!sourceOrder.size) return images;
  return images
    .map((url, index) => ({ url, index, sourceIndex: sourceOrder.get(encarPhotoUrl(url)) }))
    .sort((left, right) => {
      if (left.sourceIndex === undefined) return right.sourceIndex === undefined ? left.index - right.index : 1;
      if (right.sourceIndex === undefined) return -1;
      return left.sourceIndex - right.sourceIndex || left.index - right.index;
    })
    .map(({ url }) => url);
}
