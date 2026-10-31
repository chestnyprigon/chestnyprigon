import "server-only";
import { createHash } from "node:crypto";
import { createStaleCache } from "./stale-cache";
import { normalizeMobileDeFacets } from "./facets";
import { normalizeMobileDeListing } from "./normalize";
import type { MobileDeFacets, MobileDeFilters, MobileDeListing, MobileDeListingPage } from "./types";

const API_ROOT = "https://api.koredigital.co.kr/v1/internal/mobile-de";
const catalogCache = createStaleCache<MobileDeListingPage>(60_000, 15 * 60_000, 96);
const facetsCache = createStaleCache<MobileDeFacets>(5 * 60_000, 30 * 60_000, 64);

export class MobileDeApiError extends Error {
  constructor(readonly status: number | null, message: string) {
    super(message);
    this.name = "MobileDeApiError";
  }
}

function token() {
  const value = process.env.MASTER_MOBILE_DE_API_TOKEN?.trim();
  if (!value) throw new MobileDeApiError(null, "Mobile.de API token is not configured");
  return value;
}

async function getJson<T>(path: string, params?: URLSearchParams): Promise<T> {
  const url = new URL(`${API_ROOT}${path}`);
  params?.forEach((value, key) => url.searchParams.set(key, value));
  const apiToken = token();

  const started = performance.now();
  let response: Response;
  try {
    const cacheableCatalogRead = path === "/listings" || path === "/facets";
    const requestInit: RequestInit & { next?: { revalidate: number } } = {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      // Keep public catalog browsing available through a brief Master DB slowdown.
      // Next serves the last successful response while it refreshes stale entries.
      ...(cacheableCatalogRead ? { next: { revalidate: 60 } } : { cache: "no-store" as const }),
    };
    response = await fetch(url, {
      ...requestInit,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof MobileDeApiError) throw error;
    console.error("[mobile-de] Master API network request failed", {
      path,
      reason: error instanceof Error ? error.name : "UnknownError",
    });
    throw new MobileDeApiError(null, "Master API is unreachable");
  }

  if (process.env.VERCEL_ENV === "preview") console.info("[mobile-de] API timing", { path: path.startsWith("/listings/") ? "/listings/:id" : path, status: response.status, durationMs: Math.round(performance.now() - started) });

  if (!response.ok) {
    console.error("[mobile-de] Master API returned an error", { path, status: response.status });
    throw new MobileDeApiError(response.status, `Master API returned ${response.status}`);
  }
  try {
    return await response.json() as T;
  } catch {
    console.error("[mobile-de] Master API returned invalid JSON", { path, status: response.status });
    throw new MobileDeApiError(response.status, "Master API returned invalid JSON");
  }
}

export function getMobileDeListings(filters: MobileDeFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  params.sort();
  const consumer = createHash("sha256").update(token()).digest("hex");
  return catalogCache(JSON.stringify([consumer, params.toString()]), () =>
    getJson<MobileDeListingPage>("/listings", params).then((payload) => ({ ...payload, data: payload.data.map((listing) => normalizeMobileDeListing(listing)) })),
  );
}

// Facets are public catalogue metadata. Keep the last known-good set available
// during upstream DB timeouts; never cache details or consumer credentials.
export function getMobileDeFacets(make?: string) {
  // A rotated or different consumer token must never reuse another consumer's dictionary.
  const consumer = createHash("sha256").update(token()).digest("hex");
  const params = new URLSearchParams();
  if (make) params.set("make", make);
  return facetsCache(JSON.stringify([consumer, make || ""]), () =>
    getJson<unknown>("/facets", params).then(normalizeMobileDeFacets),
  );
}

export function getMobileDeListing(masterId: string) {
  return getJson<{ data: MobileDeListing } | MobileDeListing>(`/listings/${encodeURIComponent(masterId)}`).then((payload) =>
    normalizeMobileDeListing("data" in payload ? payload.data : payload),
  );
}
