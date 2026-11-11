import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";
import { getMobileDeListing } from "@/lib/mobile-de/api";
import { loadLivePricingContext } from "@/lib/pricing/pricing-context";
import { calculateRussiaVehicleSnapshotFresh, type CatalogVehicle } from "@/lib/pricing/russia-vehicle-pricing";
import { compactRussiaPriceSnapshot } from "@/lib/pricing/russia-pricing";
import type { Database } from "@/lib/supabase/database.types";

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

    const snapshotClient = createSupabaseAdminClient();
    const listingId = body.source === "korea" ? body.id : vehicle.sourceId;
    const { data: previousSnapshot, error: snapshotReadError } = await snapshotClient.from("russia_price_snapshots")
      .select("power_resolution,revision")
      .eq("source", body.source).eq("listing_id", listingId).eq("destination", "RU").maybeSingle();
    if (snapshotReadError) return errorResponse("Не удалось загрузить сохранённые данные расчёта.", 503);
    const result = await calculateRussiaVehicleSnapshotFresh(vehicle, previousSnapshot?.power_resolution, async (powerResolution) => {
      if (!previousSnapshot || JSON.stringify(powerResolution) === JSON.stringify(previousSnapshot.power_resolution)) return;
      const { error } = await snapshotClient.from("russia_price_snapshots").update({
        power_resolution: powerResolution as unknown as Database["public"]["Tables"]["russia_price_snapshots"]["Update"]["power_resolution"],
        updated_at: new Date().toISOString(),
      }).eq("source", body.source as "korea" | "europe").eq("listing_id", listingId).eq("destination", "RU").eq("revision", previousSnapshot.revision);
      if (error) throw new Error("Could not persist resolved vehicle power");
    });
    const calculation = result.calculation;
    const storedAt = new Date();
    const snapshotValues: Database["public"]["Tables"]["russia_price_snapshots"]["Insert"] = {
      source: body.source,
      listing_id: listingId,
      destination: "RU",
      status: "ready",
      calculation: compactRussiaPriceSnapshot(calculation) as unknown as import("@/lib/supabase/database.types").Json,
      power_resolution: result.powerResolution as unknown as import("@/lib/supabase/database.types").Json,
      calculated_at: storedAt.toISOString(),
      last_attempt_at: storedAt.toISOString(),
      next_refresh_at: "9999-12-31T00:00:00.000Z",
      last_error_code: null,
      updated_at: storedAt.toISOString(),
    };
    const write = previousSnapshot
      ? await snapshotClient.from("russia_price_snapshots").update(snapshotValues)
        .eq("source", body.source).eq("listing_id", listingId).eq("destination", "RU")
        .eq("revision", previousSnapshot.revision).select("listing_id")
      : await snapshotClient.from("russia_price_snapshots").insert(snapshotValues).select("listing_id");
    const storeError = write.error;
    if (storeError) return errorResponse("Не удалось сохранить актуальную цену. Повторите позже.", 503);
    if (!write.data?.length) return errorResponse("Расчёт изменился во время обновления. Повторите запрос.", 409);
    return NextResponse.json({ calculation }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    console.error("[russia-price-refresh] Calculation unavailable", { source: body.source, errorName: error instanceof Error ? error.name : "UnknownError" });
    return errorResponse("Актуальный расчёт временно недоступен. Попробуйте позже.", 503);
  }
}
