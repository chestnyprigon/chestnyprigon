/** Shared base limits for the Encar intake pipeline. */
export const ENCAR_MIN_VEHICLE_AGE_YEARS = 7;
export const ENCAR_MAX_MILEAGE_KM = 190_000;

export function encarYearFrom(yearTo: number) {
  return yearTo - ENCAR_MIN_VEHICLE_AGE_YEARS;
}
