/**
 * Customer-confirmed catalog intake limits.
 *
 * The seven-year rule is inclusive of the current model year, so the default
 * range in 2026 remains 2019–2026. The UI may search older imported vehicles
 * down to 2016 when the customer explicitly selects those years.
 */
export const CATALOG_VEHICLE_AGE_YEARS = 7;
export const CATALOG_MAX_MILEAGE_KM = 190_000;
export const CATALOG_FILTER_MIN_YEAR = 2016;

export function catalogYearTo(now = new Date()) {
  return now.getFullYear();
}

export function catalogYearFrom(now = new Date()) {
  return catalogYearTo(now) - CATALOG_VEHICLE_AGE_YEARS;
}

export function catalogYearOptions(now = new Date()) {
  const from = CATALOG_FILTER_MIN_YEAR;
  const to = catalogYearTo(now);
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}
