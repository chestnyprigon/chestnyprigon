import type { EncarBundle, EncarDetail, EncarSearchListing } from "./types";

const LIST_ENDPOINT = "https://api.encar.com/search/car/list/general";
const DETAIL_ENDPOINT = "https://api.encar.com/v1/readside/vehicle";

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
  Referer: "https://www.encar.com/",
  Origin: "https://www.encar.com",
};

type SearchResponse = {
  Count?: number;
  SearchResults?: EncarSearchListing[];
};

async function fetchJson<T>(url: URL | string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`Encar returned HTTP ${response.status} for ${url}`);
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Encar request failed for ${url}`);
}

export const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createDomesticQuery(yearFrom: number, yearTo: number, maxMileage: number) {
  return `(And.Hidden.N._.CarType.Y._.Year.range(${yearFrom}00..${yearTo}99)._.Mileage.range(..${maxMileage})._.Price.range(300..15000).)`;
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

export async function fetchDetail(listingId: string): Promise<EncarDetail> {
  const detail = await fetchJson<EncarDetail>(`${DETAIL_ENDPOINT}/${listingId}`);
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
