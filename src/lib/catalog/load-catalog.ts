import "server-only";
import type { AccidentSummary, CatalogCar, CarFuel, InspectionSummary, VehicleOption } from "@/data/cars";
import type { BelarusPriceCalculation } from "@/lib/pricing/chestny-prigon-profile";
import { calculateBelarusPrice } from "@/lib/pricing/chestny-prigon-profile";
import { encarPhotoUrl } from "@/lib/encar/images";
import { createSupabasePublicServerClient } from "@/lib/supabase/public-client";
import type { Database } from "@/lib/supabase/database.types";

type CatalogRow = Database["public"]["Views"]["catalog_vehicles"]["Row"];
type VehicleRow = Database["public"]["Tables"]["vehicles"]["Row"];

export type CatalogSearch = {
  page?: number;
  perPage?: number;
  query?: string;
  brand?: string;
  model?: string;
  generation?: string;
  trim?: string;
  fuel?: string;
  yearFrom?: number;
  yearTo?: number;
  minEngine?: number;
  maxEngine?: number;
  minPrice?: number;
  maxPrice?: number;
  minMileage?: number;
  maxMileage?: number;
  transmission?: string;
  drive?: string;
  bodyType?: string;
  accidents?: "clear" | "with";
  sort?: "newest" | "price-asc" | "price-desc";
};

export type CatalogPage = {
  cars: CatalogCar[];
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
  brands: string[];
  models: string[];
  generations: string[];
  trims: string[];
};

function fuelName(source: string | null): CarFuel {
  const fuel = (source ?? "").toLowerCase();
  if (/하이브리드|hybrid|hev|phev|plug[ -]?in|가솔린\s*\+\s*전기|디젤\s*\+\s*전기/u.test(fuel)) return "Гибрид";
  if (fuel.includes("전기") || fuel.includes("electric")) return "Электро";
  if (fuel.includes("디젤") || fuel.includes("diesel")) return "Дизель";
  if (fuel.includes("lpg") || fuel.includes("가스")) return "Газ";
  if (fuel.includes("가솔린") || fuel.includes("gasoline")) return "Бензин";
  return "Другое";
}

function locationName(source: string | null) {
  if (!source) return "Южная Корея";
  const locations: Array<[string, string]> = [["서울", "Сеул"], ["인천", "Инчхон"], ["부산", "Пусан"], ["경기", "Кёнгидо"], ["전북", "Чолла-Пукто"], ["전남", "Чолла-Намдо"], ["충북", "Чхунчхон-Пукто"], ["충남", "Чхунчхон-Намдо"], ["경북", "Кёнсан-Пукто"], ["경남", "Кёнсан-Намдо"], ["대구", "Тэгу"], ["대전", "Тэджон"], ["광주", "Кванджу"], ["울산", "Ульсан"]];
  return locations.reduce((result, [korean, russian]) => result.replace(korean, russian), source);
}

function normalizedSourceFuel(source: string) {
  const fuel = fuelName(source);
  if (fuel === "Электро") return "electric";
  if (fuel === "Дизель") return "diesel";
  if (fuel === "Гибрид") return "hybrid";
  if (fuel === "Газ") return "lpg";
  return "gasoline";
}

const hasHangul = (value: string) => /[\uac00-\ud7af]/.test(value);

function normalizedValue(value: string | null, dictionary: Array<[string, string]>, fallback: string | null = null) {
  if (!value) return null;
  const normalized = dictionary.reduce((result, [source, target]) => result.replaceAll(source, target), value).replace(/\s{2,}/g, " ").trim();
  return hasHangul(normalized) ? fallback : normalized;
}

function trimName(value: string | null) {
  return normalizedValue(value, [
    ["인스퍼레이션", "Inspiration"], ["프레스티지", "Prestige"], ["시그니처", "Signature"],
    ["노블레스", "Noblesse"], ["프리미엄", "Premium"], ["럭셔리", "Luxury"], ["모던", "Modern"],
  ], "Заводская комплектация");
}

function bodyName(value: string | null) {
  return normalizedValue(value, [["세단", "Седан"], ["SUV", "SUV"], ["승합", "Минивэн"], ["해치백", "Хэтчбек"], ["쿠페", "Купе"], ["왜건", "Универсал"], ["트럭", "Пикап"]], "Не указан");
}

function driveName(value: string | null) {
  return normalizedValue(value, [["전륜", "Передний"], ["후륜", "Задний"], ["4륜", "Полный"], ["2륜", "2WD"], ["구동", " привод"], ["4WD", "Полный"]], "Не указан");
}

function resolvedDrive(value: string | null, trim: string | null) {
  const source = `${value ?? ""} ${trim ?? ""}`.toUpperCase();
  if (source.includes("AWD") || source.includes("4WD") || source.includes("4륜")) return "Полный";
  if (source.includes("FWD") || source.includes("전륜")) return "Передний";
  if (source.includes("RWD") || source.includes("후륜")) return "Задний";
  return driveName(value) ?? "Не указан";
}

function transmissionName(value: string | null) {
  return normalizedValue(value, [["오토", "Автомат"], ["자동", "Автомат"], ["수동", "Механика"], ["무단", "Вариатор"]], "Не указана");
}

function colorName(value: string | null) {
  return normalizedValue(value, [["검정색", "Чёрный"], ["검정", "Чёрный"], ["블랙", "Чёрный"], ["흰색", "Белый"], ["흰", "Белый"], ["화이트", "Белый"], ["회색", "Серый"], ["그레이", "Серый"], ["은색", "Серебристый"], ["실버", "Серебристый"], ["파란색", "Синий"], ["파랑", "Синий"], ["블루", "Синий"], ["빨간색", "Красный"], ["빨강", "Красный"], ["레드", "Красный"], ["녹색", "Зелёный"], ["초록", "Зелёный"], ["그린", "Зелёный"], ["갈색", "Коричневый"], ["브라운", "Коричневый"], ["노란색", "Жёлтый"], ["노랑", "Жёлтый"], ["옐로", "Жёлтый"], ["주황", "Оранжевый"], ["오렌지", "Оранжевый"], ["보라", "Фиолетовый"], ["퍼플", "Фиолетовый"], ["베이지", "Бежевый"], ["금색", "Золотистый"], ["진주색", "Жемчужный"], ["메탈", "металлик"], ["색", ""]], "Не указан");
}

function optionLabel(value: string) {
  return normalizedValue(value, [
    ["255/40R21 미쉐린 타이어 & 휠 (프리뷰 전자제어 서스펜션 포함)", "Шины Michelin 255/40 R21, диски и адаптивная подвеска"],
    ["255/40R21 미쉐린 타이어 & 스포츠 전용 휠", "Шины Michelin 255/40 R21 и спортивные диски"],
    ["235/55R19 미쉐린 타이어 & 휠", "Шины Michelin 235/55 R19 и диски"],
    ["스포츠 디자인 셀렉션Ⅰ", "Пакет Sport Design Selection I"], ["스포츠 디자인 셀렉션Ⅱ", "Пакет Sport Design Selection II"],
    ["시그니쳐 디자인 셀렉션 I", "Пакет Signature Design Selection I"], ["시그니쳐 디자인 셀렉션 II", "Пакет Signature Design Selection II"],
    ["드라이빙 어시스턴스 패키지 Ⅰ", "Пакет ассистентов водителя I"], ["드라이빙 어시스턴스 패키지 II", "Пакет ассистентов водителя II"],
    ["프리뷰 전자제어 서스펜션", "Адаптивная электронная подвеска"], ["스포츠 패키지", "Спортивный пакет"],
    ["매트 컬러", "Матовая окраска кузова"], ["하이테크 패키지", "Пакет High-Tech"], ["2열 컴포트 패키지", "Пакет комфорта второго ряда"],
    ["아웃도어 패키지", "Пакет Outdoor"], ["렉시콘 사운드 패키지", "Аудиосистема Lexicon"], ["파퓰러 패키지 I", "Пакет Popular I"], ["파퓰러 패키지 II", "Пакет Popular II"],
    ["BOSE 프리미엄 사운드", "Премиальная аудиосистема Bose"], ["빌트인 캠 패키지", "Пакет встроенного видеорегистратора"], ["빌트인 캠", "Встроенный видеорегистратор"],
    ["컴포트", "Пакет комфорта"], ["파노라마 선루프", "Панорамная крыша"], ["헤드업 디스플레이", "Проекционный дисплей"],
    ["디지털 키", "Цифровой ключ"], ["스마트 크루즈", "Адаптивный круиз-контроль"], ["서라운드 뷰", "Камеры кругового обзора"],
    ["트레일러 패키지", "Пакет для прицепа"], ["컨비니언스 패키지", "Пакет Convenience"], ["공기 청정기", "Система очистки воздуха"], ["후석 전동식 사이드 스텝", "Электроподножки второго ряда"],
    ["Genuine Accessories", "Оригинальные аксессуары"], ["프리미엄", "Премиум"], ["사운드", "аудиосистема"],
  ], "Дополнительная заводская опция") ?? "Дополнительная заводская опция";
}

function inspectionTitle(value: string) {
  const labels: Array<[string, string]> = [["원동기", "Двигатель"], ["변속기", "Трансмиссия"], ["작동상태", "Работа двигателя"], ["실린더 커버", "Клапанная крышка"], ["실린더 헤드", "Головка блока и прокладка"], ["실린더 블록", "Блок цилиндров и поддон"], ["오일 유량", "Уровень моторного масла"], ["워터펌프", "Водяной насос"], ["라디에이터", "Радиатор"], ["냉각수", "Уровень охлаждающей жидкости"], ["오일누유", "Утечка масла"], ["오일유량", "Масло трансмиссии"], ["등속조인트", "ШРУС"], ["추친축", "Карданный вал и подшипники"], ["디피렌셜", "Дифференциал"], ["동력조향", "Гидроусилитель руля"], ["동력전달", "Привод"], ["조향", "Рулевое управление"], ["제동", "Тормозная система"], ["전기", "Электрооборудование"], ["연료", "Топливная система"], ["배출", "Выхлопная система"], ["등화", "Световые приборы"], ["차대", "Кузов и рама"]];
  return labels.find(([source]) => value.includes(source))?.[1] ?? null;
}

function inspectionStatus(value: string) {
  return normalizedValue(value, [["양호", "Исправно"], ["없음", "Не обнаружено"], ["적정", "Норма"], ["불량", "Требует внимания"], ["미세누유", "Незначительная течь"], ["누유", "Течь"]], "Проверено") ?? "Проверено";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asBoolean(value: unknown) {
  return value === true;
}

function parseOptions(value: unknown): VehicleOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const option = record(item);
    const name = asString(option.name);
    if (!name) return [];
    return [{
      name: optionLabel(name),
      priceKrw: Number.isFinite(Number(option.priceKrw)) ? Number(option.priceKrw) : null,
      description: null,
    }];
  }).filter((option, index, all) => all.findIndex((candidate) => candidate.name === option.name && candidate.priceKrw === option.priceKrw) === index);
}

function parseInspection(value: unknown): InspectionSummary | null {
  if (!value || typeof value !== "object") return null;
  const summary = record(value);
  const checks = Array.isArray(summary.checks)
    ? summary.checks.flatMap((item) => {
        const check = record(item);
        const sourceTitle = asString(check.title);
        const status = asString(check.status);
        const title = sourceTitle ? inspectionTitle(sourceTitle) : null;
        return title && status ? [{ title, status: inspectionStatus(status) }] : [];
      })
    : [];
  return {
    state: asString(summary.state) ? inspectionStatus(String(summary.state)) : null,
    reportedAccident: asBoolean(summary.reportedAccident),
    simpleRepair: asBoolean(summary.simpleRepair),
    waterlog: asBoolean(summary.waterlog),
    tuning: asBoolean(summary.tuning),
    recallCompleted: asBoolean(summary.recallCompleted),
    usageHistory: Array.isArray(summary.usageHistory)
      ? summary.usageHistory.filter((item): item is string => typeof item === "string")
      : [],
    firstRegistrationDate: asString(summary.firstRegistrationDate),
    inspectionMileage: asNumber(summary.inspectionMileage) || null,
    checks,
    bodyFindings: Array.isArray(summary.bodyFindings)
      ? summary.bodyFindings.flatMap((item) => {
          const finding = record(item);
          const title = asString(finding.title);
          if (!title) return [];
          const statuses = Array.isArray(finding.statuses)
            ? finding.statuses.flatMap((status) => {
                if (typeof status === "string") return [{ code: null, title: status }];
                const value = record(status);
                const statusTitle = asString(value.title);
                return statusTitle ? [{ code: asString(value.code), title: statusTitle }] : [];
              })
            : [];
          return [{ code: asString(finding.code), title, statuses }];
        })
      : [],
    standardOptionCodes: Array.isArray(summary.standardOptionCodes)
      ? summary.standardOptionCodes.filter((item): item is string => typeof item === "string")
      : [],
    inspectionImages: Array.isArray(summary.inspectionImages)
      ? summary.inspectionImages.flatMap((item) => {
          const image = record(item);
          const url = asString(image.url);
          const title = asString(image.title);
          return url && title ? [{ url, title }] : [];
        })
      : [],
  };
}

function parseImageGroups(value: unknown, images: string[]) {
  const summary = record(value);
  const groupByUrl = new Map<string, "Кузов" | "Салон" | "Детали" | "Другие фото">();
  if (Array.isArray(summary.photoGroups)) {
    for (const item of summary.photoGroups) {
      const photo = record(item);
      const url = asString(photo.url);
      const group = asString(photo.group);
      if (url && (group === "Кузов" || group === "Салон" || group === "Детали" || group === "Другие фото")) groupByUrl.set(encarPhotoUrl(url), group);
    }
  }
  return images.map((url) => ({ url, group: groupByUrl.get(encarPhotoUrl(url)) ?? "Другие фото" }));
}

function parseAccidents(value: unknown): AccidentSummary | null {
  if (!value || typeof value !== "object") return null;
  const summary = record(value);
  return {
    available: asBoolean(summary.available),
    accidentCount: asNumber(summary.accidentCount),
    ownAccidentCount: asNumber(summary.ownAccidentCount),
    otherAccidentCount: asNumber(summary.otherAccidentCount),
    ownerChangeCount: asNumber(summary.ownerChangeCount),
    ownAccidentCostKrw: asNumber(summary.ownAccidentCostKrw),
    otherAccidentCostKrw: asNumber(summary.otherAccidentCostKrw),
    totalLossCount: asNumber(summary.totalLossCount),
    floodTotalLossCount: asNumber(summary.floodTotalLossCount),
    floodPartLossCount: asNumber(summary.floodPartLossCount),
    theftCount: asNumber(summary.theftCount),
    loanCount: asNumber(summary.loanCount),
    insuranceEvents: Array.isArray(summary.insuranceEvents)
      ? summary.insuranceEvents.flatMap((item) => {
          const event = record(item);
          const date = asString(event.date);
          const type = asString(event.type);
          const amountKrw = asNumber(event.amountKrw);
          return date && type && amountKrw
            ? [{ date, type, amountKrw, partsKrw: asNumber(event.partsKrw) || null, paintingKrw: asNumber(event.paintingKrw) || null, laborKrw: asNumber(event.laborKrw) || null }]
            : [];
        })
      : [],
  };
}

function mapCatalogRows(data: CatalogRow[]): CatalogCar[] {
  return data.flatMap((row) => {
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
      preferential: false,
    });
    const images = (row.image_urls ?? []).map(encarPhotoUrl);
    if (!images.length) return [];

    return [
      {
        id: row.id,
        sourceListingId: row.source_listing_id,
        brand: row.manufacturer,
        model: row.model,
        trim: trimName(row.trim) ?? trimName(row.generation) ?? "Комплектация не указана",
        generation: trimName(row.generation),
        year: row.model_year,
        registrationDate: row.first_registration_date,
        mileage: row.mileage_km,
        engine: row.engine_cc ? `${(row.engine_cc / 1000).toFixed(1)} л` : "Электро",
        engineCc: row.engine_cc,
        fuel: fuelName(row.fuel_type),
        sourceFuel: normalizedSourceFuel(row.fuel_type),
        drive: resolvedDrive(row.drive_type, row.trim),
        bodyType: bodyName(row.body_type),
        color: colorName(row.exterior_color),
        transmission: transmissionName(row.transmission),
        vinMasked: row.vin_masked,
        price: calculation.totalUsd ?? 0,
        sourcePriceKrw: Number(row.price_krw),
        location: locationName(row.location),
        images,
        imageGroups: parseImageGroups(row.inspection_summary, images),
        sourceUrl: row.source_url,
        publishedAt: row.published_at,
        sourceUpdatedAt: row.source_updated_at,
        lastSeenAt: row.last_seen_at,
        status: "Проверено" as const,
        calculation,
        options: parseOptions(row.report_options),
        inspection: parseInspection(row.inspection_summary),
        accidents: parseAccidents(row.accident_summary),
        reportStatus: row.report_status,
        reportFetchedAt: row.report_fetched_at,
      },
    ];
  });
}

function mapVehicleRows(
  data: VehicleRow[],
  imagesByVehicle: Map<string, string[]>,
  reportsByVehicle: Map<string, { inspection_summary: unknown; accident_summary: unknown; report_status: string; fetched_at: string }>,
): CatalogCar[] {
  return data.flatMap((row) => {
    const images = (imagesByVehicle.get(row.id) ?? []).map(encarPhotoUrl);
    if (!images.length) return [];
    const report = reportsByVehicle.get(row.id);
    let calculation: BelarusPriceCalculation;
    try {
      calculation = calculateBelarusPrice({
        priceKrw: Number(row.price_krw), engineCc: row.engine_cc, firstRegistrationDate: row.first_registration_date,
        fuelType: row.fuel_type, preferential: false,
      });
    } catch {
      return [];
    }
    return [{
      id: row.id, sourceListingId: row.source_listing_id, brand: row.manufacturer, model: row.model,
      trim: trimName(row.trim) ?? trimName(row.generation) ?? "Комплектация не указана", generation: trimName(row.generation),
      year: row.model_year, registrationDate: row.first_registration_date, mileage: row.mileage_km,
      engine: row.engine_cc ? `${(row.engine_cc / 1000).toFixed(1)} л` : "Электро", engineCc: row.engine_cc,
      fuel: fuelName(row.fuel_type), sourceFuel: normalizedSourceFuel(row.fuel_type), drive: resolvedDrive(row.drive_type, row.trim),
      bodyType: bodyName(row.body_type), color: colorName(row.exterior_color), transmission: transmissionName(row.transmission),
      vinMasked: row.vin_masked, price: row.price_usd ?? calculation.totalUsd ?? 0, sourcePriceKrw: Number(row.price_krw),
      location: locationName(row.location), images, imageGroups: parseImageGroups(report?.inspection_summary, images), sourceUrl: row.source_url,
      publishedAt: row.published_at, sourceUpdatedAt: row.source_updated_at, lastSeenAt: row.last_seen_at, status: "Проверено" as const,
      calculation, options: [], inspection: parseInspection(report?.inspection_summary), accidents: parseAccidents(report?.accident_summary),
      reportStatus: report?.report_status ?? null, reportFetchedAt: report?.fetched_at ?? null,
    }];
  });
}

function normalizedSearch(search: CatalogSearch) {
  return {
    page: Math.max(1, search.page ?? 1), perPage: Math.min(48, Math.max(12, search.perPage ?? 24)),
    query: search.query?.trim() ?? "", brand: search.brand ?? "", model: search.model ?? "", generation: search.generation ?? "", trim: search.trim ?? "", fuel: search.fuel ?? "",
    yearFrom: search.yearFrom ?? 2021, yearTo: search.yearTo ?? 2026, minPrice: search.minPrice ?? 0,
    maxPrice: search.maxPrice ?? 100_000, minMileage: search.minMileage ?? 0, maxMileage: search.maxMileage ?? 190_000,
    minEngine: search.minEngine ?? 0, maxEngine: search.maxEngine ?? 8_000,
    transmission: search.transmission ?? "", drive: search.drive ?? "", bodyType: search.bodyType ?? "",
    accidents: search.accidents, sort: search.sort ?? "newest" as const,
  };
}

async function loadAccidentVehicleIds(
  client: ReturnType<typeof createSupabasePublicServerClient>,
  filter: NonNullable<CatalogSearch["accidents"]>,
) {
  const ids: string[] = [];
  const pageSize = 1_000;

  for (let from = 0; from < 50_000; from += pageSize) {
    const { data, error } = await client
      .from("vehicle_reports")
      .select("vehicle_id,accident_summary")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Accident filter request failed: ${error.message}`);

    for (const report of data ?? []) {
      const summary = record(report.accident_summary);
      const accidentCount = asNumber(summary.accidentCount);
      const reportAvailable = asBoolean(summary.available);
      if ((filter === "with" && accidentCount > 0) || (filter === "clear" && reportAvailable && accidentCount === 0)) {
        ids.push(report.vehicle_id);
      }
    }
    if (!data || data.length < pageSize) break;
  }

  return ids;
}

export async function loadCatalogPage(search: CatalogSearch = {}): Promise<CatalogPage> {
  const client = createSupabasePublicServerClient();
  const input = normalizedSearch(search);
  const from = (input.page - 1) * input.perPage;
  let query = client
    .from("vehicles")
    .select("id,source_listing_id,manufacturer,model,generation,trim,model_year,first_registration_date,mileage_km,price_krw,price_usd,engine_cc,fuel_type,transmission,drive_type,body_type,exterior_color,location,vin_masked,source_url,published_at,source_updated_at,last_seen_at,status,is_public", { count: "exact" })
    .eq("is_public", true).eq("status", "active").neq("fuel_type", "전기").neq("fuel_type", "수소")
    .gte("model_year", Math.min(input.yearFrom, input.yearTo)).lte("model_year", Math.max(input.yearFrom, input.yearTo))
    .gte("price_usd", Math.min(input.minPrice, input.maxPrice)).lte("price_usd", Math.max(input.minPrice, input.maxPrice))
    .gte("mileage_km", Math.min(input.minMileage, input.maxMileage)).lte("mileage_km", Math.max(input.minMileage, input.maxMileage))
    .gte("engine_cc", Math.min(input.minEngine, input.maxEngine)).lte("engine_cc", Math.max(input.minEngine, input.maxEngine));
  if (input.brand) query = query.eq("manufacturer", input.brand);
  if (input.model) query = query.eq("model", input.model);
  if (input.generation) query = query.eq("generation", input.generation);
  if (input.trim) query = query.eq("trim", input.trim);
  if (input.fuel === "Бензин") query = query.ilike("fuel_type", "%가솔린%").not("fuel_type", "ilike", "%전기%");
  if (input.fuel === "Дизель") query = query.ilike("fuel_type", "%디젤%").not("fuel_type", "ilike", "%전기%");
  if (input.fuel === "Гибрид") query = query.or("fuel_type.ilike.%하이브리드%,fuel_type.ilike.%전기%,fuel_type.ilike.%hev%,fuel_type.ilike.%phev%").neq("fuel_type", "전기");
  if (input.fuel === "Газ") query = query.or("fuel_type.ilike.%LPG%,fuel_type.ilike.%가스%");
  if (input.transmission === "Автомат") query = query.or("transmission.ilike.%자동%,transmission.ilike.%오토%");
  if (input.transmission === "Механика") query = query.ilike("transmission", "%수동%");
  if (input.transmission === "Вариатор") query = query.ilike("transmission", "%무단%");
  if (input.drive === "Полный") query = query.or("drive_type.ilike.%4WD%,drive_type.ilike.%AWD%,drive_type.ilike.%4륜%");
  if (input.drive === "Передний") query = query.ilike("drive_type", "%전륜%");
  if (input.drive === "Задний") query = query.ilike("drive_type", "%후륜%");
  if (input.drive === "2WD") query = query.ilike("drive_type", "%2WD%");
  if (input.bodyType) query = query.ilike("body_type", `%${input.bodyType === "Минивэн" ? "승합" : input.bodyType}%`);
  if (input.query) {
    const term = input.query.replace(/[,%()]/g, " ").trim();
    if (term) query = query.or(`manufacturer.ilike.%${term}%,model.ilike.%${term}%,generation.ilike.%${term}%,trim.ilike.%${term}%`);
  }
  query = input.sort === "price-asc" ? query.order("price_usd", { ascending: true }) : input.sort === "price-desc" ? query.order("price_usd", { ascending: false }) : query.order("published_at", { ascending: false }).order("id", { ascending: false });
  let vehicles: VehicleRow[] | null = null;
  let count: number | null = null;
  if (input.accidents) {
    // A large PostgREST `id IN (...)` request exceeds the URL limit. For this
    // optional filter we load the already narrowed vehicle set, apply report
    // identifiers in memory, then paginate. The ordinary catalogue path stays
    // database-paginated and fast.
    const matchingIds = new Set(await loadAccidentVehicleIds(client, input.accidents));
    if (matchingIds.size) {
      const { data, error } = await query.limit(10_000);
      if (error) throw new Error(`Catalog request failed: ${error.message}`);
      const matching = ((data ?? []) as VehicleRow[]).filter((vehicle) => matchingIds.has(vehicle.id));
      count = matching.length;
      vehicles = matching.slice(from, from + input.perPage);
    } else {
      vehicles = [];
      count = 0;
    }
  } else {
    const result = await query.range(from, from + input.perPage - 1);
    if (result.error) throw new Error(`Catalog request failed: ${result.error.message}`);
    vehicles = result.data as VehicleRow[] | null;
    count = result.count;
  }
  const ids = (vehicles ?? []).map((vehicle) => vehicle.id);
  const [imagesResult, reportsResult] = ids.length ? await Promise.all([
    client.from("vehicle_images").select("vehicle_id,source_url,position").in("vehicle_id", ids).order("position", { ascending: true }),
    client.from("vehicle_reports").select("vehicle_id,inspection_summary,accident_summary,report_status,fetched_at").in("vehicle_id", ids),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  if (imagesResult.error || reportsResult.error) throw new Error(`Catalog related data failed: ${imagesResult.error?.message ?? reportsResult.error?.message}`);
  const imagesByVehicle = new Map<string, string[]>();
  for (const image of imagesResult.data ?? []) imagesByVehicle.set(image.vehicle_id, [...(imagesByVehicle.get(image.vehicle_id) ?? []), image.source_url]);
  const reportsByVehicle = new Map((reportsResult.data ?? []).map((report) => [report.vehicle_id, report]));
  const publicBrands = ["Chevrolet", "Genesis", "Hyundai", "KGM", "Kia", "Renault Korea"];
  const pageCars = mapVehicleRows((vehicles ?? []) as VehicleRow[], imagesByVehicle, reportsByVehicle);
  return {
    cars: pageCars,
    total: count ?? 0,
    page: input.page,
    perPage: input.perPage,
    hasMore: from + input.perPage < (count ?? 0),
    brands: publicBrands,
    models: [...new Set(pageCars.map((car) => car.model))],
    generations: [...new Set((vehicles ?? []).flatMap((car) => car.generation ? [car.generation] : []))],
    trims: [...new Set((vehicles ?? []).flatMap((car) => car.trim ? [car.trim] : []))],
  };
}

export async function loadCatalogCars(limit = 100): Promise<CatalogCar[]> {
  const client = createSupabasePublicServerClient();
  const pageSize = 100;
  const rows: CatalogRow[] = [];

  // `catalog_vehicles` joins photos and the Encar report. Requesting the full
  // catalogue in one statement times out once the catalogue grows. Small pages
  // keep each database query predictable while preserving the current UI.
  for (let from = 0; from < limit; from += pageSize) {
    const { data, error } = await client
      .from("catalog_vehicles")
      .select("*")
      .order("model_year", { ascending: false })
      .order("published_at", { ascending: false })
      .range(from, Math.min(from + pageSize - 1, limit - 1));

    if (error) throw new Error(`Catalog request failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }

  return mapCatalogRows(rows);
}

export async function loadCatalogCar(id: string): Promise<CatalogCar | null> {
  const client = createSupabasePublicServerClient();
  const byId = await client
    .from("catalog_vehicles")
    .select("*")
    .eq("id", id)
    .limit(1);

  if (byId.error) throw new Error(`Vehicle request failed: ${byId.error.message}`);
  if (byId.data?.length) return mapCatalogRows(byId.data)[0] ?? null;

  const byListingId = await client
    .from("catalog_vehicles")
    .select("*")
    .eq("source_listing_id", id)
    .limit(1);

  if (byListingId.error) throw new Error(`Vehicle request failed: ${byListingId.error.message}`);
  return mapCatalogRows(byListingId.data ?? [])[0] ?? null;
}
