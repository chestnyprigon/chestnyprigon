/** Sizes advertised by mobile.de's own image srcset. Keep the original as fallback. */
export function mobileDeImageCandidates(source: string, size: "thumbnail" | "main" | "full"): string[] {
  try {
    const url = new URL(source);
    if (url.hostname !== "img.classistatic.de" || !url.pathname.startsWith("/api/v1/mo-prod/images/")) return [source];
    const sizes = size === "thumbnail" ? [200, 360, 640] : size === "full" ? [1600, 1024, 640] : [1024, 1600, 640];
    return [...new Set([...sizes.map((width) => { const variant = new URL(url); variant.searchParams.set("rule", `mo-${width}`); return variant.toString(); }), source])];
  } catch { return [source]; }
}
