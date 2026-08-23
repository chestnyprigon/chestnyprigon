import { notFound } from "next/navigation";
import { VehicleDossier } from "@/components/catalog/VehicleDossier";
import { loadCatalogCar } from "@/lib/catalog/load-catalog";
import { loadPricingContext } from "@/lib/pricing/pricing-context";

export const dynamic = "force-dynamic";

export default async function VehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const car = await loadCatalogCar(id);
  if (!car) notFound();
  const pricingContext = await loadPricingContext();
  return <VehicleDossier car={car} pricingContext={pricingContext} />;
}
