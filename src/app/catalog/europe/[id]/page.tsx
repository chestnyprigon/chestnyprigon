import { notFound } from "next/navigation";
import { MobileDeUnavailable } from "@/components/mobile-de/MobileDeCatalog";
import { MobileDeDossier } from "@/components/mobile-de/MobileDeDossier";
import { readCalculationPreference } from "@/lib/pricing/country-preference";
import { getMobileDeListing, MobileDeApiError } from "@/lib/mobile-de/api";

export const dynamic = "force-dynamic";

export default async function EuropeListingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const preference = await readCalculationPreference(query);
  let listing;
  try {
    listing = await getMobileDeListing(id);
  } catch (error) {
    if (error instanceof MobileDeApiError && error.status === 404) notFound();
    if (error instanceof MobileDeApiError) {
      return <MobileDeUnavailable error={error} />;
    }
    throw error;
  }
  return <MobileDeDossier listing={listing} destination={preference.destination} currency={preference.currency} />;
}
