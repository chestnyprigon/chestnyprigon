import { PremiumLanding } from "@/components/landing/PremiumLanding";
import { HomeCatalogShowcase } from "@/components/landing/HomeCatalogShowcase";
import { readCalculationPreference } from "@/lib/pricing/country-preference";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const preference = await readCalculationPreference(await searchParams);
  return <PremiumLanding destination={preference.destination} currency={preference.currency} catalogShowcase={<HomeCatalogShowcase destination={preference.destination} currency={preference.currency} />} />;
}
