import { catalogYearOptions } from "./catalog-rules";

export const YEAR_OPTIONS = catalogYearOptions();

export const ENGINE_MIN_OPTIONS = [0, 1_000, 1_500, 1_600, 2_000, 2_500, 3_000, 3_500, 4_000] as const;
export const ENGINE_MAX_OPTIONS = [1_000, 1_500, 1_600, 2_000, 2_500, 3_000, 3_500, 4_000, 5_000, 8_000] as const;

export const MILEAGE_MIN_OPTIONS = [0, 10_000, 30_000, 50_000, 80_000, 100_000, 150_000] as const;
export const MILEAGE_MAX_OPTIONS = [10_000, 30_000, 50_000, 80_000, 100_000, 150_000, 190_000] as const;

export const PRICE_MIN_OPTIONS = [0, 10_000, 15_000, 20_000, 30_000, 40_000, 60_000] as const;
export const PRICE_MAX_OPTIONS = [10_000, 15_000, 20_000, 30_000, 40_000, 60_000, 80_000, 100_000, 150_000, 200_000, 250_000] as const;
