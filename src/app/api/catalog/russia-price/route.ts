import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";
import { getMobileDeListing } from "@/lib/mobile-de/api";
import { loadLivePricingContext } from "@/lib/pricing/pricing-context";
import { calculateRussiaVehiclePriceFresh, type CatalogVehicle } from "@/lib/pricing/russia-vehicle-pricing";
import { compactRussiaPriceSnapshot } from "@/lib/pricing/russia-pricing";

export const dynamic = "force-dynamic";

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 6;
const requests = new Map<string, { count: number; expiresAt: number }>();

function allowed(request: Request) {
  const key = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip") ?? "unknown";
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

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function POST(request: Request) {
  if (!allowed(request)) return errorResponse("Слишком много запросов. Повторите обновление через минуту.", 429);
  const body = await request.json().catch(() => null) as { source?: unknown; id?: unknown } | null;
  if (!body || (body.source !== "korea" && body.source !== "europe") || typeof body.id !== "string") {
    return errorResponse("Некорректный автомобиль для пересчёта.", 400);
  }

  try {
    let vehicle: CatalogVehicle;
    if (body.source === "korea") {
      if (!/^[0-9a-f-]{36}$/i.test(body.id)) return errorResponse("Некорректный автомобиль.", 400);
      const client = createSupabaseAdminClient();
      const { data, error } = await client.from("vehicles")
        .select("id,source_listing_id,manufacturer,model,generation,trim,model_year,first_registration_date,engine_cc,fuel_type,drive_type,price_krw,engine_power_ps,engine_power_kw,electric_30min_kw,electric_motor_peak_kw,system_combined_power_kw,power_basis,power_confidence,power_source_type,power_source_url")
        .eq("id", body.id).eq("status", "active").eq("is_public", true).maybeSingle();
      if (error) return errorResponse("Не удалось загрузить автомобиль.", 500);
      if (!data) return errorResponse("Автомобиль не найден в опубликованном каталоге.", 404);
      const pricing = await loadLivePricingContext();
      vehicle = {
        source: "korea", sourceId: data.source_listing_id, brand: data.manufacturer, model: data.model,
        generation: data.generation, trim: data.trim, year: data.model_year, firstRegistration: data.first_registration_date,
        engineCc: data.engine_cc, fuelType: data.fuel_type, driveType: data.drive_type,
        price: Number(data.price_krw), currency: "KRW", powerPs: data.engine_power_ps ?? undefined,
        enginePowerKw: data.engine_power_kw, electric30MinKw: data.electric_30min_kw,
        electricPeakKw: data.electric_motor_peak_kw, systemCombinedPowerKw: data.system_combined_power_kw,
        powerBasis: data.power_basis, powerConfidence: data.power_confidence,
        powerSourceRef: [data.power_source_type, data.power_source_url].filter(Boolean).join(":"),
        krwPerUsd: pricing.krwUsdRate.effectiveKrwPerUsd,
      };
    } else {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(body.id)) return errorResponse("Некорректный автомобиль.", 400);
      const listing = await getMobileDeListing(body.id);
      const amount = listing.net_price?.amount ?? listing.price?.amount;
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return errorResponse("В объявлении нет цены для пересчёта.", 422);
      const powerValue = listing.power?.value;
      const powerIsKw = /kw/i.test(`${listing.power?.unit ?? ""} ${listing.power?.label_ru ?? ""}`);
      vehicle = {
        source: "europe", sourceId: listing.master_id, brand: listing.make ?? "", model: listing.model ?? listing.title,
        year: Number(listing.first_registration?.value?.slice(0, 4)) || null,
        firstRegistration: listing.first_registration?.value, engineCc: listing.engine_cc,
        fuelType: listing.fuel_type, driveType: listing.drive, price: amount, currency: "EUR",
        powerKw: powerValue && powerIsKw ? powerValue : undefined,
        powerPs: powerValue && !powerIsKw ? powerValue : undefined,
      };
    }

    const calculation = await calculateRussiaVehiclePriceFresh(vehicle);
    const storedAt = new Date();
    const { error: storeError } = await createSupabaseAdminClient().from("russia_price_snapshots").upsert({
      source: body.source,
      listing_id: body.source === "korea" ? body.id : vehicle.sourceId,
      destination: "RU",
      status: "ready",
      calculation: compactRussiaPriceSnapshot(calculation) as unknown as import("@/lib/supabase/database.types").Json,
      calculated_at: storedAt.toISOString(),
      last_attempt_at: storedAt.toISOString(),
      next_refresh_at: new Date(storedAt.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
      last_error_code: null,
      updated_at: storedAt.toISOString(),
    }, { onConflict: "source,listing_id,destination" });
    if (storeError) return errorResponse("Не удалось сохранить актуальную цену. Повторите позже.", 503);
    return NextResponse.json({ calculation }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    console.error("[russia-price-refresh] Calculation unavailable", { source: body.source, errorName: error instanceof Error ? error.name : "UnknownError" });
    return errorResponse("Актуальный расчёт временно недоступен. Попробуйте позже.", 503);
  }
}
