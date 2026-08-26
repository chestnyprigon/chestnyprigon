import "server-only";

import { CHESTNY_PRIGON_PRICING_PROFILE, FALLBACK_EXCHANGE_RATES, type ExchangeRates, type PricingProfile } from "@/lib/pricing/chestny-prigon-profile";
import { fetchNbrbRates, NBRB_DAILY_URL } from "@/lib/pricing/nbrb-rates";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

export type PricingContext = { profile: PricingProfile; exchangeRates: ExchangeRates };
const CACHE_ID = "nbrb-daily";

function isoDate(date = new Date()) { return date.toISOString().slice(0, 10); }
function decimal(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : null; }

export async function loadPricingContext(): Promise<PricingContext> {
  try {
    const client = createSupabaseAdminClient();
    const [profileResult, cacheResult] = await Promise.all([
      client.from("pricing_profiles").select("version,krw_per_usd,delivery_usd,commission_rate,svh_declarant_eur,customs_clearance_eur,company_service_usd").eq("id", "belarus-default").maybeSingle(),
      client.from("pricing_exchange_rates").select("rate_date,usd_byn,eur_byn").eq("id", CACHE_ID).maybeSingle(),
    ]);
    const profileRow = profileResult.data;
    const cacheRow = cacheResult.data;
    const profile: PricingProfile = profileRow ? {
      version: profileRow.version,
      krwPerUsd: Number(profileRow.krw_per_usd), deliveryUsd: Number(profileRow.delivery_usd), commissionRate: Number(profileRow.commission_rate),
      svhDeclarantEur: Number(profileRow.svh_declarant_eur), customsClearanceEur: Number(profileRow.customs_clearance_eur),
      companyServiceUsd: Number(profileRow.company_service_usd),
    } : CHESTNY_PRIGON_PRICING_PROFILE;
    const cached: ExchangeRates | null = cacheRow && decimal(cacheRow.usd_byn) && decimal(cacheRow.eur_byn)
      ? { usdByn: Number(cacheRow.usd_byn), eurByn: Number(cacheRow.eur_byn), rateDate: cacheRow.rate_date, source: "nbrb" }
      : null;
    if (cached?.rateDate === isoDate()) return { profile, exchangeRates: cached };
    try {
      const fresh = await fetchNbrbRates();
      if (!profileResult.error && !cacheResult.error) {
        await client.from("pricing_exchange_rates").upsert({ id: CACHE_ID, rate_date: fresh.rateDate, usd_byn: fresh.usdByn, eur_byn: fresh.eurByn, source_url: NBRB_DAILY_URL, fetched_at: new Date().toISOString() });
      }
      return { profile, exchangeRates: fresh };
    } catch {
      return { profile, exchangeRates: cached ?? FALLBACK_EXCHANGE_RATES };
    }
  } catch {
    return { profile: CHESTNY_PRIGON_PRICING_PROFILE, exchangeRates: FALLBACK_EXCHANGE_RATES };
  }
}
