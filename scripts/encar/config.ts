/** Shared base limits for the Encar intake pipeline. */
import {
  CATALOG_MAX_MILEAGE_KM,
  CATALOG_VEHICLE_AGE_YEARS,
} from "../../src/lib/catalog/catalog-rules";

export const ENCAR_MIN_VEHICLE_AGE_YEARS = CATALOG_VEHICLE_AGE_YEARS;
export const ENCAR_MAX_MILEAGE_KM = CATALOG_MAX_MILEAGE_KM;

export function encarYearFrom(yearTo: number) {
  return yearTo - ENCAR_MIN_VEHICLE_AGE_YEARS;
}
