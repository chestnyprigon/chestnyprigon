"use client";
import { mobileDeImageCandidates } from "./images";
type Size = "thumbnail" | "main" | "full";
const ready = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const keyFor = (source: string, size: Size) => `${size}:${source}`;
export function loadedMobileDeImage(source: string, size: Size) {
  return ready.get(keyFor(source, size));
}
function decodeImage(url: string, priority: "high" | "low") {
  return new Promise<void>((resolve, reject) => {
    const image = new Image();
    const timeout = setTimeout(() => finish(Error("Image timeout")), 8_000);
    function finish(error?: Error) {
      clearTimeout(timeout); image.onload = null; image.onerror = null;
      if (error) reject(error); else resolve();
    }
    image.referrerPolicy = "no-referrer";
    image.fetchPriority = priority;
    image.onload = () => { image.decode().then(() => finish(), () => finish(Error("Image decode failed"))); };
    image.onerror = () => finish(Error("Image unavailable"));
    image.src = url;
  });
}
/** Share decoded URLs and in-flight loads between stage, neighbours, and fullscreen. */
export function loadMobileDeImage(source: string, size: Size, priority: "high" | "low" = "high") {
  const key = keyFor(source, size);
  const cached = ready.get(key);
  if (cached) return Promise.resolve(cached);
  const running = pending.get(key);
  if (running) return running;
  const task = (async () => {
    const variants = mobileDeImageCandidates(source, size);
    // Try alternate valid sizes before retrying a URL the browser may have cached as failed.
    for (let round = 0; round < 2; round++) {
      for (const url of variants) {
        try {
          await decodeImage(url, priority);
          if (ready.size >= 160) ready.delete(ready.keys().next().value!);
          ready.set(key, url);
          return url;
        } catch { /* Try the next size without displaying a broken native image. */ }
      }
      if (round === 0) await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw Error("Photo unavailable");
  })().finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
