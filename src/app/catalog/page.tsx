import type { Metadata } from "next";
import { PremiumCatalog } from "@/components/catalog/PremiumCatalog";
import { loadCatalogPage, type CatalogSearch } from "@/lib/catalog/load-catalog";
import { CATALOG_MAX_MILEAGE_KM, catalogYearFrom, catalogYearTo } from "@/lib/catalog/catalog-rules";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Каталог автомобилей из Кореи — Честный пригон",
  description: "Подбор автомобилей из Южной Кореи с доставкой в Беларусь и ценами в долларах США.",
};

function integer(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default async function CatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const get = (name: string) => typeof params[name] === "string" ? params[name] : undefined;
  const search: CatalogSearch = {
    page: integer(get("page"), 1), query: get("q"), brand: get("brand"), model: get("model"), generation: get("generation"), trim: get("trim"), fuel: get("fuel"),
    yearFrom: integer(get("yearFrom"), catalogYearFrom()), yearTo: integer(get("yearTo"), catalogYearTo()),
    minEngine: integer(get("minEngine"), 0), maxEngine: integer(get("maxEngine"), 8_000),
    minPrice: integer(get("minPrice"), 0), maxPrice: integer(get("maxPrice"), 100_000), minMileage: integer(get("minMileage"), 0), maxMileage: integer(get("maxMileage"), CATALOG_MAX_MILEAGE_KM),
    transmission: get("transmission"), drive: get("drive"), bodyType: get("bodyType"),
    accidents: get("accidents") === "clear" ? "clear" : get("accidents") === "with" ? "with" : undefined,
    sort: get("sort") === "price-asc" ? "price-asc" : get("sort") === "price-desc" ? "price-desc" : "newest",
  };
  const catalog = await loadCatalogPage(search);
  return <PremiumCatalog catalog={catalog} initialSearch={search} />;
}
