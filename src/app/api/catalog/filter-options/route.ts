import { NextResponse } from "next/server";
import { loadCatalogFilterOptions } from "@/lib/catalog/filter-options-server";

export const dynamic = "force-dynamic";

/**
 * Provides only values that exist in the public catalogue branch selected by
 * the visitor. The raw trim remains the query value, so a filter can never
 * merge similar-looking grades from different makes or models.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const brand = params.get("brand")?.trim();
  const model = params.get("model")?.trim();
  try {
    const options = await loadCatalogFilterOptions(brand, model);
    return NextResponse.json(options, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  } catch {
    return NextResponse.json({ error: "Не удалось получить варианты фильтра" }, { status: 500 });
  }
}
