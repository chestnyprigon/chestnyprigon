import type { Metadata } from "next";
import { PremiumCatalog } from "@/components/catalog/PremiumCatalog";

export const metadata: Metadata = {
  title: "Каталог автомобилей из Кореи — Честный пригон",
  description: "Подбор автомобилей из Южной Кореи с доставкой в Беларусь и ценами в долларах США.",
};

export default function CatalogPage() {
  return <PremiumCatalog />;
}
