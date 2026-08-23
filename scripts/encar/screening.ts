import type { EncarBundle, ScreeningResult } from "./types";
import { ENCAR_MAX_MILEAGE_KM } from "./config";

export const SCREENING_RULES_VERSION = "2026-08-09.1";

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
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nestedNumber(record: unknown, key: string) {
  if (!record || typeof record !== "object") return null;
  return asNumber((record as Record<string, unknown>)[key]);
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
  const reasons: string[] = [];

  if (isLease) reasons.push("lease_detected");
  if (isRental) reasons.push(rentalPlate ? "rental_plate_detected" : "rental_detected");
  if (isTaxi) reasons.push("taxi_detected");
  if (isCommercial) reasons.push("commercial_detected");

  const year = Math.floor(Number(bundle.search.Year) / 100) || Number(bundle.search.FormYear);
  const mileage = asNumber(bundle.search.Mileage);
  const price = asNumber(bundle.search.Price);
  const photos = Array.isArray(bundle.detail.photos)
    ? bundle.detail.photos.filter((photo) => Boolean(photo.path))
    : [];
  const status = advertisement.status;
  const seizing = (bundle.detail.condition as Record<string, unknown> | undefined)?.seizing;
  const seizingCount = nestedNumber(seizing, "seizingCount");
  const pledgeCount = nestedNumber(seizing, "pledgeCount");

  if (!Number.isInteger(year) || year < 1990 || year > new Date().getFullYear() + 1) {
    reasons.push("invalid_model_year");
  }
  if (mileage === null || mileage < 0 || mileage > ENCAR_MAX_MILEAGE_KM) reasons.push("invalid_mileage");
  if (price === null || price <= 0) reasons.push("invalid_price");
  if (!bundle.search.Manufacturer || !bundle.search.Model) reasons.push("missing_identity");
  if (photos.length < 5) reasons.push("insufficient_photos");
  if (status && status !== "ADVERTISE") reasons.push("not_advertised");
  if ((seizingCount ?? 0) > 0) reasons.push("seizure_record");
  if ((pledgeCount ?? 0) > 0) reasons.push("pledge_record");

  const hardExclusion = isLease || isRental || isTaxi || isCommercial;
  const invalidData = reasons.some((reason) =>
    [
      "invalid_model_year",
      "invalid_mileage",
      "invalid_price",
      "missing_identity",
      "insufficient_photos",
      "not_advertised",
    ].includes(reason),
  );
  const needsReview = reasons.some((reason) => ["seizure_record", "pledge_record"].includes(reason));
  const isProblematic = invalidData || needsReview;

  return {
    decision: hardExclusion ? "rejected" : isProblematic ? "manual_review" : "approved",
    isLease,
    isRental,
    isTaxi,
    isCommercial,
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
  };
}
