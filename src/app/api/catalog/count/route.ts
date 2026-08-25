import { NextResponse } from "next/server";
import { loadCatalogPage, type CatalogSearch } from "@/lib/catalog/load-catalog";

export const dynamic = "force-dynamic";

function integer(value: string | null | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const get = (name: string) => searchParams.get(name) ?? undefined;
  const search: CatalogSearch = {
    // The loader always fetches a small page to preserve exactly the same
    // public/status and report rules as the catalogue itself.
    page: 1,
    perPage: 12,
    query: get("q"),
    brand: get("brand"),
    model: get("model"),
    fuel: get("fuel"),
    yearFrom: integer(get("yearFrom"), 2021),
    yearTo: integer(get("yearTo"), 2026),
    minEngine: integer(get("minEngine"), 0),
    maxEngine: integer(get("maxEngine"), 8_000),
    minPrice: integer(get("minPrice"), 0),
    maxPrice: integer(get("maxPrice"), 100_000),
    minMileage: integer(get("minMileage"), 0),
    maxMileage: integer(get("maxMileage"), 190_000),
    transmission: get("transmission"),
    drive: get("drive"),
    bodyType: get("bodyType"),
    accidents: get("accidents") === "clear" ? "clear" : get("accidents") === "with" ? "with" : undefined,
  };
  const catalog = await loadCatalogPage(search);
  return NextResponse.json(
    { total: catalog.total },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
