/**
 * Customer-confirmed catalog intake limits.
 *
 * The seven-year rule is inclusive of the current model year, so in 2026
 * the selectable range is 2019–2026.
 */
export const CATALOG_VEHICLE_AGE_YEARS = 7;
export const CATALOG_MAX_MILEAGE_KM = 190_000;

export function catalogYearTo(now = new Date()) {
  return now.getFullYear();
}

export function catalogYearFrom(now = new Date()) {
  return catalogYearTo(now) - CATALOG_VEHICLE_AGE_YEARS;
}

export function catalogYearOptions(now = new Date()) {
  const from = catalogYearFrom(now);
  const to = catalogYearTo(now);
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}
