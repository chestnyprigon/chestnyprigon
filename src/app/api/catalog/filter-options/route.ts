import { NextResponse } from "next/server";
import { createSupabasePublicServerClient } from "@/lib/supabase/public-client";

export const dynamic = "force-dynamic";

function uniqueSorted(values: Array<string | null>) {
  return [...new Set(values.flatMap((value) => value?.trim() ? [value.trim()] : []))]
    .sort((left, right) => left.localeCompare(right, "ru"));
}

/**
 * Provides only values that exist in the public catalogue branch selected by
 * the visitor. The raw trim remains the query value, so a filter can never
 * merge similar-looking grades from different makes or models.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const brand = params.get("brand")?.trim();
  const model = params.get("model")?.trim();
  const client = createSupabasePublicServerClient();
  const rows: Array<{ manufacturer: string | null; model: string | null; trim: string | null }> = [];
  const pageSize = 1_000;

  // Supabase/PostgREST caps a single response at 1,000 rows in this project.
  // Read every page so recently added makes are not silently absent from the UI.
  for (let from = 0; from < 50_000; from += pageSize) {
    let query = client
      .from("vehicles")
      .select("manufacturer,model,trim")
      .eq("is_public", true)
      .eq("status", "active")
      .neq("fuel_type", "전기")
      .neq("fuel_type", "수소")
      .not("price_usd", "is", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (brand) query = query.eq("manufacturer", brand);
    if (model) query = query.eq("model", model);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: "Не удалось получить варианты фильтра" }, { status: 500 });
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }

  return NextResponse.json(
    {
      brands: brand ? [] : uniqueSorted(rows.map((row) => row.manufacturer)),
      models: brand && !model ? uniqueSorted(rows.map((row) => row.model)) : [],
      trims: brand && model ? uniqueSorted(rows.map((row) => row.trim)) : [],
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
