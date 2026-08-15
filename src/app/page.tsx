import { PremiumLanding } from "@/components/landing/PremiumLanding";
import { loadCatalogCars } from "@/lib/catalog/load-catalog";

export const dynamic = "force-dynamic";

export default async function Home() {
  const cars = await loadCatalogCars(12);
  return <PremiumLanding cars={cars.slice(0, 6)} />;
}
