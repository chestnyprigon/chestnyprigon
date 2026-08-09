import "server-only";
import type { CatalogCar, CarFuel } from "@/data/cars";
import { calculateBelarusPrice } from "@/lib/pricing/emavto-profile";
import { createSupabasePublicServerClient } from "@/lib/supabase/public-client";

function fuelName(source: string | null): CarFuel {
  const fuel = (source ?? "").toLowerCase();
  if (fuel.includes("하이브리드") || fuel.includes("hybrid")) return "Гибрид";
  if (fuel.includes("전기") || fuel.includes("electric")) return "Электро";
  if (fuel.includes("디젤") || fuel.includes("diesel")) return "Дизель";
  if (fuel.includes("lpg") || fuel.includes("가스")) return "Газ";
  if (fuel.includes("가솔린") || fuel.includes("gasoline")) return "Бензин";
  return "Другое";
}

function locationName(source: string | null) {
  if (!source) return "Южная Корея";
  return source.replace("서울", "Сеул").replace("인천", "Инчхон").replace("부산", "Пусан");
}

export async function loadCatalogCars(): Promise<CatalogCar[]> {
  const client = createSupabasePublicServerClient();
  const { data, error } = await client
    .from("catalog_vehicles")
    .select("*")
    .order("model_year", { ascending: false })
    .order("published_at", { ascending: false })
    .limit(100);

  if (error) throw new Error(`Catalog request failed: ${error.message}`);

  return (data ?? []).flatMap((row) => {
    if (
      !row.id ||
      !row.source_listing_id ||
      !row.manufacturer ||
      !row.model ||
      !row.model_year ||
      row.mileage_km === null ||
      row.price_krw === null ||
      !row.fuel_type ||
      !row.source_url
    ) {
      return [];
    }
    const calculation = calculateBelarusPrice({
      priceKrw: Number(row.price_krw),
      engineCc: row.engine_cc,
      firstRegistrationDate: row.first_registration_date,
      fuelType: row.fuel_type,
      preferential: true,
    });
    const images = row.image_urls ?? [];
    if (!images.length) return [];

    return [
      {
        id: row.id,
        sourceListingId: row.source_listing_id,
        brand: row.manufacturer,
        model: row.model,
        trim: row.trim ?? row.generation ?? "Комплектация не указана",
        year: row.model_year,
        registrationDate: row.first_registration_date,
        mileage: row.mileage_km,
        engine: row.engine_cc ? `${(row.engine_cc / 1000).toFixed(1)} л` : "Электро",
        engineCc: row.engine_cc,
        fuel: fuelName(row.fuel_type),
        sourceFuel: row.fuel_type,
        drive: row.drive_type ?? "Не указан",
        bodyType: row.body_type,
        color: row.exterior_color,
        price: calculation.totalUsd,
        sourcePriceKrw: Number(row.price_krw),
        location: locationName(row.location),
        images,
        sourceUrl: row.source_url,
        status: "Проверено" as const,
        calculation,
      },
    ];
  });
}
