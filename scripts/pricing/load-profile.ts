import type { SupabaseClient } from "@supabase/supabase-js";
import { CHESTNY_PRIGON_PRICING_PROFILE, type PricingProfile } from "../../src/lib/pricing/chestny-prigon-profile";

function positive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Keeps command-line imports on the same stored commercial rate as the site. */
export async function loadPersistedPricingProfile(client: SupabaseClient): Promise<PricingProfile> {
  const [profileResult, rateResult] = await Promise.all([
    client
      .from("pricing_profiles")
      .select("version,krw_per_usd,delivery_usd,commission_rate,svh_declarant_eur,customs_clearance_eur,company_service_usd")
      .eq("id", "belarus-default")
      .maybeSingle(),
    client
      .from("pricing_krw_usdt_rates")
      .select("effective_krw_per_usd")
      .eq("id", "naver-bithumb-usdt")
      .maybeSingle(),
  ]);
  if (profileResult.error) throw new Error(`Unable to load pricing profile: ${profileResult.error.message}`);
  const row = profileResult.data;
  const profile: PricingProfile = row ? {
    version: String(row.version),
    krwPerUsd: positive(row.krw_per_usd) ?? CHESTNY_PRIGON_PRICING_PROFILE.krwPerUsd,
    deliveryUsd: Number(row.delivery_usd),
    commissionRate: Number(row.commission_rate),
    svhDeclarantEur: Number(row.svh_declarant_eur),
    customsClearanceEur: Number(row.customs_clearance_eur),
    companyServiceUsd: Number(row.company_service_usd),
  } : CHESTNY_PRIGON_PRICING_PROFILE;
  // The rate table may not exist until its migration is applied. In that case
  // the previous approved manual profile remains the safe fallback.
  const effectiveKrwPerUsd = rateResult.error ? null : positive(rateResult.data?.effective_krw_per_usd);
  return effectiveKrwPerUsd ? { ...profile, krwPerUsd: effectiveKrwPerUsd } : profile;
}
