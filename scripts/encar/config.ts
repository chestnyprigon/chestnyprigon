/** Shared base limits for the Encar intake pipeline. */
import {
  CATALOG_MAX_MILEAGE_KM,
  CATALOG_VEHICLE_AGE_YEARS,
} from "../../src/lib/catalog/catalog-rules";

export const ENCAR_MIN_VEHICLE_AGE_YEARS = CATALOG_VEHICLE_AGE_YEARS;
export const ENCAR_MAX_MILEAGE_KM = CATALOG_MAX_MILEAGE_KM;
// Keep a two-tier freshness policy in the intake: listings up to 180 days are
// eligible for automatic enrichment, while the publisher still requires the
// normal quality gates (active detail page, price, images and screening).
export const ENCAR_MAX_LISTING_AGE_DAYS = 180;

export function encarYearFrom(yearTo: number) {
  return yearTo - ENCAR_MIN_VEHICLE_AGE_YEARS;
}
