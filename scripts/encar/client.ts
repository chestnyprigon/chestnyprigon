import type { EncarBundle, EncarDetail, EncarSearchListing } from "./types";
import { encarHeaders, ensureEncarVerified } from "./auth";

const LIST_ENDPOINT = "https://api.encar.com/search/car/list/general";
const DETAIL_ENDPOINT = "https://api.encar.com/v1/readside/vehicle";

type SearchResponse = {
  Count?: number;
  SearchResults?: EncarSearchListing[];
};

async function fetchJson<T>(url: URL | string, options: { attempts?: number; timeoutMs?: number } = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 20_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await ensureEncarVerified();
      const response = await fetch(url, { headers: encarHeaders(), signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`Encar returned HTTP ${response.status} for ${url}`);
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Encar request failed for ${url}`);
}

export const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createDomesticQuery(
  yearFrom: number,
  yearTo: number,
  maxMileage: number,
  carType: "Y" | "N" = "Y",
  manufacturer?: string,
  priceMin = 300,
  priceMax = 15000,
) {
  const prefix = manufacturer
    ? `(And.Hidden.N._.(C.CarType.A._.Manufacturer.${manufacturer}.)_.Year`
    : `(And.Hidden.N._.CarType.${carType}._.Year`;
  return `${prefix}.range(${yearFrom}00..${yearTo}99)._.Mileage.range(..${maxMileage})._.Price.range(${priceMin}..${priceMax}).)`;
}

export async function fetchSearchPage({
  offset,
  limit,
  query,
}: {
  offset: number;
  limit: number;
  query: string;
}) {
  const url = new URL(LIST_ENDPOINT);
  url.searchParams.set("count", "true");
  url.searchParams.set("q", query);
  url.searchParams.set("sr", `|ModifiedDate|${offset}|${limit}`);

  const payload = await fetchJson<SearchResponse>(url);
  if (!Array.isArray(payload.SearchResults)) {
    throw new Error("Encar search response does not contain SearchResults");
  }

  return {
    total: Number(payload.Count ?? 0),
    listings: payload.SearchResults,
  };
}

export async function fetchDetail(listingId: string, options?: { attempts?: number; timeoutMs?: number }): Promise<EncarDetail> {
  const detail = await fetchJson<EncarDetail>(`${DETAIL_ENDPOINT}/${listingId}`, options);
  if (!detail || typeof detail !== "object") {
    throw new Error(`Encar detail response is invalid for ${listingId}`);
  }
  return detail;
}

export async function fetchBundle(listing: EncarSearchListing): Promise<EncarBundle> {
  const listingId = String(listing.Id ?? "");
  if (!listingId) throw new Error("Encar listing has no Id");

  return {
    fetchedAt: new Date().toISOString(),
    search: listing,
    detail: await fetchDetail(listingId),
  };
}
