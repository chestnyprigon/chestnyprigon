"use client";
import { mobileDeImageCandidates } from "./images";
type Size = "thumbnail" | "main" | "full";
const ready = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const keyFor = (source: string, size: Size) => `${size}:${source}`;
export function loadedMobileDeImage(source: string, size: Size) {
  const url = ready.get(keyFor(source, size));
  if (url) created.set(url, Date.now());
  return url;
}
const references = new Map<string, number>();
const created = new Map<string, number>();
function trimCache() {
  if (ready.size <= 96) return;
  for (const [key, url] of ready) {
    // Newly resolved callers may not have committed their React effects yet.
    if (references.get(url) || Date.now() - (created.get(url) || 0) < 30_000) continue;
    ready.delete(key);
    created.delete(url);
    URL.revokeObjectURL(url);
    if (ready.size <= 96) break;
  }
}
export function retainMobileDeImage(url: string) {
  references.set(url, (references.get(url) || 0) + 1);
  return () => {
    const count = (references.get(url) || 1) - 1;
    if (count) references.set(url, count); else references.delete(url);
    trimCache();
  };
}
async function downloadImage(url: string, refresh: boolean) {
  const response = await fetch(url, {
    mode: "cors", credentials: "omit", referrerPolicy: "no-referrer",
    cache: refresh ? "reload" : "default", signal: AbortSignal.timeout(8_000),
    headers: { Accept: "image/avif,image/webp,image/*" },
  });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) throw Error("Image unavailable");
  const blob = await response.blob();
  if (!blob.size || blob.size > 8_000_000) throw Error("Invalid image size");
  const local = URL.createObjectURL(blob);
  try {
    const image = new Image(); image.src = local;
    await image.decode();
    return local;
  } catch (error) { URL.revokeObjectURL(local); throw error; }
}
/** Share decoded URLs and in-flight loads between stage, neighbours, and fullscreen. */
export function loadMobileDeImage(source: string, size: Size, priority: "high" | "low" = "high") {
  const key = keyFor(source, size);
  // Preloads start after the selected frame; all network reads remain credential-free.
  void priority;
  const cached = ready.get(key);
  if (cached) { created.set(cached, Date.now()); return Promise.resolve(cached); }
  const running = pending.get(key);
  if (running) return running;
  const task = (async () => {
    const variants = mobileDeImageCandidates(source, size);
    // Try alternate valid sizes before retrying a URL the browser may have cached as failed.
    for (let round = 0; round < 2; round++) {
      for (const url of variants) {
        try {
          const local = await downloadImage(url, round > 0);
          created.set(local, Date.now());
          ready.set(key, local);
          trimCache();
          return local;
        } catch { /* Try the next size without displaying a broken native image. */ }
      }
      if (round === 0) await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw Error("Photo unavailable");
  })().finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
