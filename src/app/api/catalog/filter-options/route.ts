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
  let query = client
    .from("vehicles")
    .select("manufacturer,model,trim")
    .eq("is_public", true)
    .eq("status", "active")
    .neq("fuel_type", "전기")
    .neq("fuel_type", "수소")
    .not("price_usd", "is", null)
    .limit(10_000);

  if (brand) query = query.eq("manufacturer", brand);
  if (model) query = query.eq("model", model);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "Не удалось получить варианты фильтра" }, { status: 500 });

  return NextResponse.json(
    {
      brands: brand ? [] : uniqueSorted((data ?? []).map((row) => row.manufacturer)),
      models: brand && !model ? uniqueSorted((data ?? []).map((row) => row.model)) : [],
      trims: brand && model ? uniqueSorted((data ?? []).map((row) => row.trim)) : [],
    },
    { headers: { "Cache-Control": "public, max-age=300, s-maxage=300" } },
  );
}
