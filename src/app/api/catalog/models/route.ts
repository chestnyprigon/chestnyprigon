import { NextResponse } from "next/server";
import { createSupabasePublicServerClient } from "@/lib/supabase/public-client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const brand = new URL(request.url).searchParams.get("brand")?.trim();
  const client = createSupabasePublicServerClient();
  let query = client
    .from("vehicles")
    .select("model")
    .eq("is_public", true)
    .eq("status", "active")
    .neq("fuel_type", "전기")
    .neq("fuel_type", "수소")
    .not("price_usd", "is", null)
    .order("model", { ascending: true })
    .limit(10_000);
  if (brand) query = query.eq("manufacturer", brand);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "Не удалось получить модели" }, { status: 500 });
  const models = [...new Set((data ?? []).flatMap((row) => row.model ? [row.model] : []))];
  return NextResponse.json(
    { models },
    { headers: { "Cache-Control": "public, max-age=300, s-maxage=300" } },
  );
}
