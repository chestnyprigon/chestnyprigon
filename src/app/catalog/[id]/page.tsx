import { notFound } from "next/navigation";
import { VehicleDossier } from "@/components/catalog/VehicleDossier";
import { loadCatalogCar } from "@/lib/catalog/load-catalog";
import { loadPricingContext } from "@/lib/pricing/pricing-context";

export const dynamic = "force-dynamic";

function safeReturnTo(value: string | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/catalog";
  return value;
}

export default async function VehiclePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const query = await searchParams;
  const car = await loadCatalogCar(id);
  if (!car) notFound();
  const pricingContext = await loadPricingContext();
  const returnTo = typeof query.returnTo === "string" ? query.returnTo : undefined;
  return <VehicleDossier car={car} pricingContext={pricingContext} catalogHref={safeReturnTo(returnTo)} />;
}
