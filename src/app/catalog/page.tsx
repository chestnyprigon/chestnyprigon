import type { Metadata } from "next";
import { PremiumCatalog } from "@/components/catalog/PremiumCatalog";
import { loadCatalogCars } from "@/lib/catalog/load-catalog";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Каталог автомобилей из Кореи — Честный пригон",
  description: "Подбор автомобилей из Южной Кореи с доставкой в Беларусь и ценами в долларах США.",
};

export default async function CatalogPage() {
  const cars = await loadCatalogCars();
  return <PremiumCatalog cars={cars} />;
}
