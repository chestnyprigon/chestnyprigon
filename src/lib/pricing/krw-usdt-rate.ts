import type { SupabaseClient } from "@supabase/supabase-js";

export const NAVER_USDT_KRW_PAGE_URL = "https://m.stock.naver.com/fchart/crypto/BITHUMB/USDT";
export const NAVER_USDT_KRW_API_URL = "https://m.stock.naver.com/front-api/chart/cryptoChartData";
export const KRW_USDT_ADJUSTMENT = -9;
export const KRW_USDT_RATE_ID = "naver-bithumb-usdt";

const MIN_VALID_KRW_PER_USDT = 1_000;
const MAX_VALID_KRW_PER_USDT = 2_000;
const LIVE_CACHE_MS = 5 * 60 * 1_000;

export type KrwUsdRate = {
  rawKrwPerUsdt: number | null;
  adjustmentKrw: number | null;
  effectiveKrwPerUsd: number;
  fetchedAt: string | null;
  sourceAsOf: string | null;
  source: "naver-bithumb" | "stored-naver-bithumb" | "manual";
  stale: boolean;
};

type NaverCandle = {
  closePrice?: unknown;
  lastTradeAt?: unknown;
  tradeBaseAt?: unknown;
};

type NaverPayload = {
  isSuccess?: unknown;
  result?: unknown;
};

let liveCache: { expiresAt: number; rate: KrwUsdRate } | null = null;

function validPositiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function validDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function rateFromRaw(rawKrwPerUsdt: number, fetchedAt: string, sourceAsOf: string | null, source: KrwUsdRate["source"]): KrwUsdRate {
  if (!Number.isFinite(rawKrwPerUsdt) || rawKrwPerUsdt < MIN_VALID_KRW_PER_USDT || rawKrwPerUsdt > MAX_VALID_KRW_PER_USDT) {
    throw new Error("Naver USDT/KRW rate is outside the accepted range");
  }
  const effectiveKrwPerUsd = rawKrwPerUsdt + KRW_USDT_ADJUSTMENT;
  if (effectiveKrwPerUsd <= 0) throw new Error("Adjusted KRW/USD rate must be positive");
  return {
    rawKrwPerUsdt,
    adjustmentKrw: KRW_USDT_ADJUSTMENT,
    effectiveKrwPerUsd,
    fetchedAt,
    sourceAsOf,
    source,
    stale: false,
  };
}

export function parseNaverUsdtKrw(payload: NaverPayload, fetchedAt = new Date().toISOString()): KrwUsdRate {
  if (payload.isSuccess !== true || !Array.isArray(payload.result)) {
    throw new Error("Naver USDT/KRW response is invalid");
  }
  const latest = payload.result.at(-1) as NaverCandle | undefined;
  const rawKrwPerUsdt = validPositiveNumber(latest?.closePrice);
  if (rawKrwPerUsdt === null) throw new Error("Naver USDT/KRW close price is missing");
  return rateFromRaw(
    rawKrwPerUsdt,
    fetchedAt,
    validDate(latest?.lastTradeAt) ?? validDate(latest?.tradeBaseAt),
    "naver-bithumb",
  );
}

export async function fetchNaverUsdtKrw({ force = false }: { force?: boolean } = {}) {
  if (!force && liveCache && liveCache.expiresAt > Date.now()) return liveCache.rate;
  const now = new Date();
  const from = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1_000);
  const url = new URL(NAVER_USDT_KRW_API_URL);
  url.searchParams.set("exchangeType", "BITHUMB");
  url.searchParams.set("nfTicker", "USDT");
  url.searchParams.set("marketType", "KRW");
  url.searchParams.set("type", "days");
  url.searchParams.set("interval", "1");
  url.searchParams.set("from", from.toISOString().slice(0, 19));
  url.searchParams.set("to", now.toISOString().slice(0, 19));

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Referer: NAVER_USDT_KRW_PAGE_URL,
      "User-Agent": "Chestny-Prigon/1.0 price calculator",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Naver USDT/KRW request failed with ${response.status}`);
  const rate = parseNaverUsdtKrw(await response.json() as NaverPayload);
  liveCache = { expiresAt: Date.now() + LIVE_CACHE_MS, rate };
  return rate;
}

export function manualKrwUsdRate(effectiveKrwPerUsd: number): KrwUsdRate {
  return {
    rawKrwPerUsdt: null,
    adjustmentKrw: null,
    effectiveKrwPerUsd,
    fetchedAt: null,
    sourceAsOf: null,
    source: "manual",
    stale: true,
  };
}

export function storedKrwUsdRate(row: Partial<{
  raw_krw_per_usdt: unknown;
  adjustment_krw: unknown;
  effective_krw_per_usd: unknown;
  fetched_at: unknown;
  source_as_of: unknown;
}>, maxAgeMs = 24 * 60 * 60 * 1_000): KrwUsdRate | null {
  const raw = validPositiveNumber(row.raw_krw_per_usdt);
  const adjustment = Number(row.adjustment_krw);
  const effective = validPositiveNumber(row.effective_krw_per_usd);
  const fetchedAt = validDate(row.fetched_at);
  if (raw === null || !Number.isFinite(adjustment) || effective === null || !fetchedAt) return null;
  try {
    const rate = rateFromRaw(raw, fetchedAt, validDate(row.source_as_of), "stored-naver-bithumb");
    if (Math.abs(rate.effectiveKrwPerUsd - effective) > 0.0001 || Math.abs(rate.adjustmentKrw! - adjustment) > 0.0001) return null;
    return { ...rate, stale: Date.now() - Date.parse(fetchedAt) > maxAgeMs };
  } catch {
    return null;
  }
}

export async function refreshStoredKrwUsdRate(client: SupabaseClient) {
  const rate = await fetchNaverUsdtKrw({ force: true });
  const { error } = await client.from("pricing_krw_usdt_rates").upsert({
    id: KRW_USDT_RATE_ID,
    raw_krw_per_usdt: rate.rawKrwPerUsdt!,
    adjustment_krw: rate.adjustmentKrw!,
    effective_krw_per_usd: rate.effectiveKrwPerUsd,
    source_url: NAVER_USDT_KRW_PAGE_URL,
    source_as_of: rate.sourceAsOf,
    fetched_at: rate.fetchedAt!,
  });
  if (error) throw new Error(`Unable to save Naver USDT/KRW rate: ${error.message}`);
  return rate;
}
