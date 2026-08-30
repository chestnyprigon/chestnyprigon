import { PremiumLanding } from "@/components/landing/PremiumLanding";
import { loadCatalogPage, type CatalogSearch } from "@/lib/catalog/load-catalog";
import { CATALOG_MAX_MILEAGE_KM, catalogYearFrom, catalogYearTo } from "@/lib/catalog/catalog-rules";

export const dynamic = "force-dynamic";

function integer(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const get = (name: string) => typeof params[name] === "string" ? params[name] : undefined;
  const search: CatalogSearch = {
    homepageMix: true,
    perPage: 12, query: get("q"), brand: get("brand"), model: get("model"), generation: get("generation"), trim: get("trim"), fuel: get("fuel"), drive: get("drive"),
    yearFrom: integer(get("yearFrom"), catalogYearFrom()), yearTo: integer(get("yearTo"), catalogYearTo()),
    minEngine: integer(get("minEngine"), 0), maxEngine: integer(get("maxEngine"), 8_000),
    minMileage: integer(get("minMileage"), 0), maxMileage: integer(get("maxMileage"), CATALOG_MAX_MILEAGE_KM),
    minPrice: integer(get("minPrice"), 0), maxPrice: integer(get("maxPrice"), 100_000),
    accidents: get("accidents") === "clear" ? "clear" : get("accidents") === "with" ? "with" : undefined,
  };
  const catalog = await loadCatalogPage(search);
  return <PremiumLanding catalog={catalog} initialSearch={search} />;
}
