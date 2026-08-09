import type { EncarBundle, NormalizedVehicle } from "./types";
import { canonicalSourceId } from "./identity";
import { encarPhotoUrl } from "../../src/lib/encar/images";

const MANUFACTURERS: Array<[RegExp, string]> = [
  [/^현대/u, "Hyundai"],
  [/^기아/u, "Kia"],
  [/^제네시스/u, "Genesis"],
  [/쉐보레|GM대우/u, "Chevrolet"],
  [/르노/u, "Renault Korea"],
  [/KG모빌리티|쌍용/u, "KGM"],
];

const PHOTO_PRIORITY: Record<string, number> = { OUTER: 0, INNER: 1, OPTION: 2 };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function manufacturerName(koreanName: string) {
  return MANUFACTURERS.find(([pattern]) => pattern.test(koreanName))?.[1] ?? koreanName;
}

function modelYear(bundle: EncarBundle) {
  const encodedYear = Number(bundle.search.Year);
  if (Number.isFinite(encodedYear) && encodedYear >= 190000) return Math.floor(encodedYear / 100);
  return Math.floor(Number(bundle.search.FormYear));
}

function maskVin(vin: unknown) {
  const value = text(vin);
  if (!value || value.length < 8) return null;
  return `${value.slice(0, 4)}${"*".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

function registrationDate(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
}

function yearMonthDate(value: unknown) {
  const raw = String(value ?? "").replace(/\D/g, "");
  if (!/^\d{6}$/.test(raw)) return null;
  const month = Number(raw.slice(4, 6));
  if (month < 1 || month > 12) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-01`;
}

function imageUrls(bundle: EncarBundle) {
  return [...(bundle.detail.photos ?? [])]
    .filter((photo) => Boolean(photo.path))
    .sort((left, right) => {
      const typeOrder = (PHOTO_PRIORITY[left.type ?? ""] ?? 9) - (PHOTO_PRIORITY[right.type ?? ""] ?? 9);
      return typeOrder || String(left.code ?? "").localeCompare(String(right.code ?? ""));
    })
    .map((photo) => encarPhotoUrl(`https://ci.encar.com${photo.path}`))
    .filter((url, index, urls) => urls.indexOf(url) === index)
    .slice(0, 30);
}

function detectedDrive(...values: Array<string | null | undefined>) {
  const source = values.filter(Boolean).join(" ").toUpperCase();
  if (/\b(?:AWD|4WD)\b|4륜/u.test(source)) return "4WD";
  if (/\bFWD\b|전륜/u.test(source)) return "FWD";
  if (/\bRWD\b|후륜/u.test(source)) return "RWD";
  if (/\b2WD\b|2륜/u.test(source)) return "2WD";
  return null;
}

export function normalizeListing(bundle: EncarBundle): NormalizedVehicle {
  const category = record(bundle.detail.category);
  const spec = record(bundle.detail.spec);
  const manage = record(bundle.detail.manage);
  const koreanManufacturer = text(category.manufacturerName) ?? text(bundle.search.Manufacturer) ?? "Unknown";
  const koreanModel = text(category.modelName) ?? text(bundle.search.Model) ?? "Unknown";
  const model = text(category.modelGroupEnglishName) ?? text(category.modelGroupName) ?? koreanModel;
  const listingId = String(bundle.search.Id);
  const firstAdvertised = manage.firstAdvertisedDateTime ?? manage.registDateTime;
  const mileage = number(spec.mileage) ?? number(bundle.search.Mileage) ?? 0;
  const price = number(record(bundle.detail.advertisement).price) ?? number(bundle.search.Price) ?? 0;
  const displacement = number(spec.displacement);

  return {
    sourceListingId: canonicalSourceId(bundle),
    manufacturer: manufacturerName(koreanManufacturer),
    model,
    generation: koreanModel !== model ? koreanModel : null,
    trim:
      text(category.gradeDetailEnglishName) ??
      text(category.gradeEnglishName) ??
      text(category.gradeDetailName) ??
      text(bundle.search.BadgeDetail) ??
      text(bundle.search.Badge),
    modelYear: modelYear(bundle),
    firstRegistrationDate:
      yearMonthDate(category.yearMonth) ?? registrationDate(firstAdvertised),
    mileageKm: Math.floor(mileage),
    priceKrw: Math.floor(price * 10_000),
    engineCc: displacement ? Math.floor(displacement) : null,
    fuelType: text(spec.fuelName) ?? text(bundle.search.FuelType) ?? "Не указано",
    transmission: text(spec.transmissionName),
    driveType: detectedDrive(
      text(spec.driveTypeName),
      text(category.driveTypeName),
      text(category.gradeEnglishName),
      text(category.gradeName),
      text(category.gradeDetailEnglishName),
      text(category.gradeDetailName),
    ),
    bodyType: text(spec.bodyName),
    exteriorColor: text(spec.customColor) ?? text(spec.colorName),
    location: text(bundle.search.OfficeCityState),
    vinMasked: maskVin(bundle.detail.vin),
    sourceUrl: `https://www.encar.com/dc/dc_cardetailview.do?carid=${listingId}`,
    sourceUpdatedAt: text(manage.modifyDateTime),
    imageUrls: imageUrls(bundle),
  };
}
