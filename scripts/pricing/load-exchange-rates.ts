import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExchangeRates } from "../../src/lib/pricing/chestny-prigon-profile";
import { fetchNbrbRates, NBRB_DAILY_URL } from "../../src/lib/pricing/nbrb-rates";

const CACHE_ID = "nbrb-daily";
const MAX_AGE_DAYS = 7;

export function validStoredRates(row: {
  rate_date: string;
  usd_byn: number;
  eur_byn: number;
}, now = new Date()): ExchangeRates | null {
  const day = Date.parse(`${row.rate_date}T00:00:00Z`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const age = (today - day) / 86_400_000;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.rate_date) || !Number.isFinite(age)
    || age < 0 || age > MAX_AGE_DAYS
    || !Number.isFinite(Number(row.usd_byn)) || Number(row.usd_byn) <= 0
    || !Number.isFinite(Number(row.eur_byn)) || Number(row.eur_byn) <= 0) return null;
  return { usdByn: Number(row.usd_byn), eurByn: Number(row.eur_byn), rateDate: row.rate_date, source: "nbrb" };
}

export async function loadRecalculationRates(client: SupabaseClient, dryRun: boolean): Promise<ExchangeRates> {
  const { data, error } = await client.from("pricing_exchange_rates")
    .select("rate_date,usd_byn,eur_byn").eq("id", CACHE_ID).maybeSingle();
  const cached = !error && data ? validStoredRates(data) : null;
  let fresh: ExchangeRates;
  try {
    // Bound the scheduled job even if the rate provider stops responding.
    fresh = await fetchNbrbRates(AbortSignal.timeout(10_000));
    if (!validStoredRates({ rate_date: fresh.rateDate!, usd_byn: fresh.usdByn, eur_byn: fresh.eurByn })) {
      throw new Error("NBRB returned invalid or stale daily rates");
    }
  } catch (cause) {
    if (!cached) throw new Error("NBRB unavailable and no valid rate cache within 7 days; prices were not recalculated");
    console.warn(JSON.stringify({ warning: "using_last_good_nbrb_cache", rateDate: cached.rateDate,
      reason: cause instanceof Error ? cause.message : String(cause) }));
    return cached;
  }
  // An older provider response must not replace a newer known-good cache.
  if (cached && cached.rateDate! > fresh.rateDate!) return cached;
  if (!dryRun && (!cached || cached.rateDate !== fresh.rateDate
    || cached.usdByn !== fresh.usdByn || cached.eurByn !== fresh.eurByn)) {
    const result = await client.from("pricing_exchange_rates").upsert({ id: CACHE_ID,
      rate_date: fresh.rateDate, usd_byn: fresh.usdByn, eur_byn: fresh.eurByn,
      source_url: NBRB_DAILY_URL, fetched_at: new Date().toISOString() });
    if (result.error) throw new Error(`Unable to save NBRB rate cache: ${result.error.message}`);
  }
  return fresh;
}
