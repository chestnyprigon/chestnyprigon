import type { EncarBundle, ScreeningResult } from "./types";
import { CATALOG_POLICY, evidence } from "./catalog-policy";
import { validateSnapshotAgainstDetail } from "./integrity";

export const SCREENING_RULES_VERSION = CATALOG_POLICY.version;

const TERM_GROUPS = {
  lease: ["리스", "운용리스", "금융리스", "리스승계", "리스 승계"],
  rental: ["렌터카", "렌트카", "장기렌트", "장기렌터카", "렌트승계", "렌트 승계"],
  taxi: ["택시", "부활택시", "영업용택시", "영업용 택시"],
  commercial: [
    "화물",
    "특장",
    "영업용",
    "앰뷸런스",
    "구급차",
    "어린이보호차",
    "어린이 보호차",
    "냉동탑차",
    "냉장탑차",
    "탑차",
    "밴",
    "캠핑카",
  ],
} as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function identityText(bundle: EncarBundle) {
  const { search, detail } = bundle;
  const category = record(detail.category);
  const spec = record(detail.spec);
  return [
    search.Manufacturer,
    search.Model,
    search.Badge,
    search.BadgeDetail,
    search.SellType,
    category.manufacturerName,
    category.modelName,
    category.modelGroupName,
    category.gradeName,
    category.gradeDetailName,
    spec.bodyName,
    spec.tradeType,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function matched(text: string, terms: readonly string[]) {
  return terms.filter((term) => text.includes(term.toLowerCase()));
}

function asNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nestedNumber(record: unknown, key: string) {
  if (!record || typeof record !== "object") return null;
  return asNumber((record as Record<string, unknown>)[key]);
}

function fuelText(bundle: EncarBundle) {
  const spec = record(bundle.detail.spec);
  return [bundle.search.FuelType, spec.fuelName]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function powertrainFlags(bundle: EncarBundle) {
  const fuel = fuelText(bundle);
  const isHybrid = /하이브리드|hybrid|hev|phev|plug[ -]?in|가솔린\s*\+\s*전기|디젤\s*\+\s*전기/u.test(fuel);
  const isHydrogen = /수소|hydrogen/u.test(fuel);
  const isElectric = !isHybrid && /전기|electric|\bev\b/u.test(fuel);
  return { isElectric, isHydrogen, isHybrid, isUnsupportedPowertrain: isElectric || isHydrogen };
}

export function screenListing(bundle: EncarBundle): ScreeningResult {
  const text = identityText(bundle);
  const advertisement = record(bundle.detail.advertisement);
  const leaseRentText = JSON.stringify(advertisement.leaseRentInfo ?? "").toLowerCase();
  const leaseTerms = [
    ...matched(text, TERM_GROUPS.lease),
    ...matched(leaseRentText, TERM_GROUPS.lease),
  ];
  const rentalTerms = [
    ...matched(text, TERM_GROUPS.rental),
    ...matched(leaseRentText, TERM_GROUPS.rental),
  ];
  const taxiTerms = matched(text, TERM_GROUPS.taxi);
  const commercialTerms = matched(text, TERM_GROUPS.commercial);
  const plate = bundle.detail.vehicleNo ?? "";
  const rentalPlate = /[하허호]/u.test(plate);

  const isLease = leaseTerms.length > 0;
  const isRental = rentalTerms.length > 0 || rentalPlate;
  const isTaxi = taxiTerms.length > 0;
  const isCommercial = commercialTerms.length > 0;
  const powertrain = powertrainFlags(bundle);
  const reasons: string[] = [];

  if (isLease) reasons.push("lease_detected");
  if (isRental) reasons.push(rentalPlate ? "rental_plate_detected" : "rental_detected");
  if (isTaxi) reasons.push("taxi_detected");
  if (isCommercial) reasons.push("commercial_detected");
  if (powertrain.isElectric) reasons.push("electric_powertrain_excluded");
  if (powertrain.isHydrogen) reasons.push("hydrogen_powertrain_excluded");

  const encodedYear = asNumber(bundle.search.Year);
  const year = encodedYear !== null && encodedYear >= 190000 ? Math.floor(encodedYear / 100) : asNumber(bundle.search.FormYear);
  const mileage = asNumber(record(bundle.detail.spec).mileage ?? bundle.search.Mileage);
  const price = asNumber(advertisement.price ?? bundle.search.Price);
  const photos = Array.isArray(bundle.detail.photos)
    ? bundle.detail.photos.filter((photo) => Boolean(photo.path))
    : [];
  const status = advertisement.status;
  const seizing = (bundle.detail.condition as Record<string, unknown> | undefined)?.seizing;
  const seizingCount = nestedNumber(seizing, "seizingCount");
  const pledgeCount = nestedNumber(seizing, "pledgeCount");

  if (year === null || !Number.isInteger(year) || year < 1990 || year > new Date().getFullYear() + 1) {
    reasons.push("invalid_model_year");
  } else if (year < CATALOG_POLICY.minYear) {
    reasons.push("model_year_below_minimum");
  }
  if (mileage === null || mileage < 0) reasons.push("invalid_mileage");
  else if (mileage > CATALOG_POLICY.maxMileageKm) reasons.push("mileage_above_maximum");
  if (price === null || price <= 0) reasons.push("invalid_price");
  if (!bundle.search.Manufacturer || !bundle.search.Model) reasons.push("missing_identity");
  if (photos.length < CATALOG_POLICY.minImages) reasons.push("insufficient_photos");
  if (!status) reasons.push("advertisement_status_missing");
  else if (!["ADVERTISE", "SALE"].includes(String(status))) reasons.push("not_advertised");
  if ((seizingCount ?? 0) > 0) reasons.push("seizure_record");
  if ((pledgeCount ?? 0) > 0) reasons.push("pledge_record");

  const integrityIssues = validateSnapshotAgainstDetail(bundle.search, bundle).filter(issue => issue.severity !== "warning");
  reasons.push(...integrityIssues.map(issue => issue.code));
  const hardExclusion = isLease || isRental || isTaxi || isCommercial || powertrain.isUnsupportedPowertrain
    || reasons.some(code => ["model_year_below_minimum", "mileage_above_maximum", "not_advertised"].includes(code));
  const invalidData = reasons.some((reason) =>
    [
      "invalid_model_year",
      "invalid_mileage",
      "invalid_price",
      "missing_identity",
      "insufficient_photos",
      "not_advertised",
      "advertisement_status_missing",
    ].includes(reason),
  );
  const needsReview = reasons.some((reason) => ["seizure_record", "pledge_record"].includes(reason));
  const isProblematic = invalidData || needsReview || integrityIssues.length > 0;
  const observed = { year, minimumYear: CATALOG_POLICY.minYear, mileageKm: mileage, maximumMileageKm: CATALOG_POLICY.maxMileageKm, price: price, photoCount: photos.length, minimumPhotos: CATALOG_POLICY.minImages, advertisementStatus: status ?? null, seizingCount, pledgeCount, fuel: fuelText(bundle), matchedTerms: { lease: leaseTerms, rental: rentalTerms, taxi: taxiTerms, commercial: commercialTerms }, rentalPlate };
  const explanations: Record<string, string> = {
    lease_detected: "В типе продажи или комплектации подтверждён лизинг.", rental_detected: "В типе продажи или комплектации подтверждена аренда.", rental_plate_detected: "Регистрационный номер содержит корейскую отметку арендного автомобиля.", taxi_detected: "В характеристиках подтверждено использование в такси.", commercial_detected: "В характеристиках подтверждено коммерческое или специальное назначение.", electric_powertrain_excluded: "Чистые электромобили исключены правилами запуска.", hydrogen_powertrain_excluded: "Водородные автомобили исключены правилами запуска.", model_year_below_minimum: "Модельный год ниже согласованного порога 2016.", mileage_above_maximum: "Пробег превышает согласованный предел 190 000 км.", invalid_model_year: "Модельный год отсутствует или некорректен.", invalid_mileage: "Пробег отсутствует или некорректен.", invalid_price: "Для расчёта стоимости нужна положительная цена Encar.", missing_identity: "В исходном объявлении отсутствует марка или модель.", insufficient_photos: "В detail недостаточно фотографий для публикации.", not_advertised: "Источник подтвердил, что объявление больше не продаётся.", advertisement_status_missing: "Источник не подтвердил активность объявления.", seizure_record: "Обнаружен арест; допуск автоматически изолирован.", pledge_record: "Обнаружен залог; допуск автоматически изолирован.",
  };

  return {
    decision: hardExclusion ? "rejected" : isProblematic ? "isolated" : "approved",
    isLease,
    isRental,
    isTaxi,
    isCommercial,
    ...powertrain,
    isProblematic,
    reasonCodes: [...new Set(reasons)],
    matchedTerms: {
      lease: leaseTerms,
      rental: rentalTerms,
      taxi: taxiTerms,
      commercial: commercialTerms,
      ...(rentalPlate ? { rentalPlate: [plate] } : {}),
    },
    rulesVersion: SCREENING_RULES_VERSION,
    reasonEvidence: [...new Set(reasons)].map(code => {
      const issue = integrityIssues.find(item => item.code === code);
      return issue ? evidence(code, `Исходный снапшот конфликтует с detail: ${issue.field}.`, { expected: issue.expected, actual: issue.actual }, issue.source)
        : evidence(code, explanations[code] ?? code, observed, "encar.search + encar.detail.category/spec/advertisement/condition/photos");
    }),
  };
}
