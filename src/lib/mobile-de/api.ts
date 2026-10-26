import "server-only";
import type { MobileDeFacets, MobileDeFilters, MobileDeListing, MobileDeListingPage } from "./types";

const API_ROOT = "https://api.koredigital.co.kr/v1/internal/mobile-de";

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

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof MobileDeApiError) throw error;
    throw new MobileDeApiError(null, "Master API is unreachable");
  }

  if (!response.ok) throw new MobileDeApiError(response.status, `Master API returned ${response.status}`);
  try {
    return await response.json() as T;
  } catch {
    throw new MobileDeApiError(response.status, "Master API returned invalid JSON");
  }
}

export function getMobileDeListings(filters: MobileDeFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  return getJson<MobileDeListingPage>("/listings", params);
}

export function getMobileDeFacets() {
  return getJson<{ data: MobileDeFacets } | MobileDeFacets>("/facets").then((payload) =>
    "data" in payload ? payload.data : payload,
  );
}

export function getMobileDeListing(masterId: string) {
  return getJson<{ data: MobileDeListing } | MobileDeListing>(`/listings/${encodeURIComponent(masterId)}`).then((payload) =>
    "data" in payload ? payload.data : payload,
  );
}
