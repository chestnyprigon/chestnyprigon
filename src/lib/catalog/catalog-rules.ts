/**
 * Customer-confirmed catalog intake limits.
 *
 * The catalogue UI intentionally defaults to 2016–the current model year so
 * the customer-requested 2016+ vehicles are visible immediately.
 */
export const CATALOG_VEHICLE_AGE_YEARS = 7;
export const CATALOG_MAX_MILEAGE_KM = 190_000;
export const CATALOG_MAX_PRICE_USD = 250_000;
export const CATALOG_FILTER_MIN_YEAR = 2016;

export function catalogYearTo(now = new Date()) {
  return now.getFullYear();
}

export function catalogYearFrom(now = new Date()) {
  return Math.min(catalogYearTo(now) - CATALOG_VEHICLE_AGE_YEARS, CATALOG_FILTER_MIN_YEAR);
}

export function catalogYearOptions(now = new Date()) {
  const from = CATALOG_FILTER_MIN_YEAR;
  const to = catalogYearTo(now);
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}
