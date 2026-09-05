import { NextResponse } from "next/server";
import { calculateBelarusPrice } from "@/lib/pricing/chestny-prigon-profile";
import { loadLivePricingContext } from "@/lib/pricing/pricing-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

export const dynamic = "force-dynamic";

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 6;
const requests = new Map<string, { count: number; expiresAt: number }>();

function clientKey(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")
    ?? "unknown";
}

function allowed(request: Request) {
  const key = clientKey(request);
  const now = Date.now();
  const current = requests.get(key);
  if (!current || current.expiresAt <= now) {
    requests.set(key, { count: 1, expiresAt: now + WINDOW_MS });
    return true;
  }
  if (current.count >= MAX_REQUESTS_PER_WINDOW) return false;
  current.count += 1;
  return true;
}

function preferentialFrom(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return true;
  return (body as { preferential?: unknown }).preferential !== false;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!allowed(request)) {
    return NextResponse.json(
      { error: "Слишком много запросов. Повторите обновление цены через минуту." },
      { status: 429, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Некорректный автомобиль." }, { status: 400 });
  }
  const body = await request.json().catch(() => null);
  const client = createSupabaseAdminClient();
  const { data: vehicle, error } = await client
    .from("vehicles")
    .select("price_krw,engine_cc,first_registration_date,fuel_type")
    .eq("id", id)
    .eq("status", "active")
    .eq("is_public", true)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Не удалось загрузить автомобиль." }, { status: 500 });
  if (!vehicle) return NextResponse.json({ error: "Автомобиль не найден в опубликованном каталоге." }, { status: 404 });

  try {
    const pricingContext = await loadLivePricingContext();
    const calculation = calculateBelarusPrice({
      priceKrw: Number(vehicle.price_krw),
      engineCc: vehicle.engine_cc,
      firstRegistrationDate: vehicle.first_registration_date,
      fuelType: vehicle.fuel_type,
      preferential: preferentialFrom(body),
      profile: pricingContext.profile,
      exchangeRates: pricingContext.exchangeRates,
    });
    return NextResponse.json(
      { calculation, krwUsdRate: pricingContext.krwUsdRate },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (priceError) {
    console.error("Unable to refresh catalogue price", priceError);
    return NextResponse.json({ error: "Актуальный расчёт временно недоступен. Попробуйте позже." }, { status: 503 });
  }
}
