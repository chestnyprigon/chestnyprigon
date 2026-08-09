import { notFound } from "next/navigation";
import { VehicleDossier } from "@/components/catalog/VehicleDossier";
import { loadCatalogCars } from "@/lib/catalog/load-catalog";

export const dynamic = "force-dynamic";

export default async function VehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const car = (await loadCatalogCars()).find((item) => item.id === id || item.sourceListingId === id);
  if (!car) notFound();
  return <VehicleDossier car={car} />;
}
