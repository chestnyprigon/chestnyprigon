import { notFound } from "next/navigation";
import { MobileDeUnavailable } from "@/components/mobile-de/MobileDeCatalog";
import { MobileDeDossier } from "@/components/mobile-de/MobileDeDossier";
import { getMobileDeListing, MobileDeApiError } from "@/lib/mobile-de/api";

export const dynamic = "force-dynamic";

export default async function EuropeListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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
  return <MobileDeDossier listing={listing} />;
}
