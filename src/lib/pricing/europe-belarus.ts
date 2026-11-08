import type { ExchangeRates } from "./chestny-prigon-profile";

export const EUROPE_BELARUS_PRICING_PROFILE = {
  version: "europe-belarus-individual-v1",
  ecServiceRate: 0.025,
  translationRate: 0.015,
  deliveryMinskEur: 2_200,
  companyServiceEur: 1_000,
  recyclingFeeByn: { upToThreeYears: 624.92, overThreeYears: 1_282.02 },
} as const;

export type EuropeBelarusPriceInput = {
  sourcePriceEur?: number;
  /** @deprecated Kept for existing callers; new Europe listings may use source Brutto. */
  netPriceEur?: number;
  priceBasis?: "netto" | "brutto" | "unknown";
  firstRegistration: string;
  engineCc: number;
  preferential?: boolean;
  exchangeRates: ExchangeRates;
  now?: Date;
};

export type EuropeBelarusPriceCalculation = {
  profileVersion: string;
  preliminary: true;
  preferential: boolean;
  ageBand: "up_to_three_years" | "three_to_five_years" | "over_five_years";
  sourcePriceEur: number;
  priceBasis: "netto" | "brutto" | "unknown";
  /** @deprecated Compatibility alias. */
  netPriceEur: number;
  ecServiceEur: number;
  translationEur: number;
  deliveryMinskEur: number;
  companyServiceEur: number;
  customsDutyEur: number;
  recyclingFeeByn: number;
  customsAndRecyclingByn: number;
  subtotalEur: number;
  totalByn: number;
  exchangeRates: ExchangeRates;
};

function validDate(value: string) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return value.length >= 10 && !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value.slice(0, 10) ? date : null;
}

function ageBand(firstRegistration: string, now: Date): EuropeBelarusPriceCalculation["ageBand"] {
  const normalized = /^\d{4}-\d{2}$/.test(firstRegistration) ? `${firstRegistration}-01` : firstRegistration;
  const date = validDate(normalized);
  if (!date) throw new Error("A first registration date is required");
  if (!Number.isFinite(now.valueOf())) throw new Error("A valid calculation date is required");
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (today < date.valueOf()) throw new Error("First registration date cannot be in the future");
  const anniversary = (years: number) => Date.UTC(date.getUTCFullYear() + years, date.getUTCMonth(), date.getUTCDate());
  if (today <= anniversary(3)) return "up_to_three_years";
  if (today <= anniversary(5)) return "three_to_five_years";
  return "over_five_years";
}

function dutyRate(priceEur: number, engineCc: number, band: EuropeBelarusPriceCalculation["ageBand"]) {
  if (band === "up_to_three_years") {
    const bracket = [
      { max: 8_500, percent: 0.54, perCc: 2.5 },
      { max: 16_700, percent: 0.48, perCc: 3.5 },
      { max: 42_300, percent: 0.48, perCc: 5.5 },
      { max: 84_500, percent: 0.48, perCc: 7.5 },
      { max: 169_000, percent: 0.48, perCc: 15 },
      { max: Number.POSITIVE_INFINITY, percent: 0.48, perCc: 20 },
    ].find(({ max }) => priceEur <= max)!;
    return Math.max(priceEur * bracket.percent, engineCc * bracket.perCc);
  }
  const rates = band === "three_to_five_years"
    ? [[1_000, 1.5], [1_500, 1.7], [1_800, 2.5], [2_300, 2.7], [3_000, 3], [Infinity, 3.6]]
    : [[1_000, 3], [1_500, 3.2], [1_800, 3.5], [2_300, 4.8], [3_000, 5], [Infinity, 5.7]];
  const perCc = rates.find(([limit]) => engineCc <= limit)![1];
  return engineCc * perCc;
}

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** Preliminary individual-import estimate from the available source price and first-registration date. */
export function calculateEuropeBelarusPrice(input: EuropeBelarusPriceInput): EuropeBelarusPriceCalculation {
  const sourcePriceEur = input.sourcePriceEur ?? input.netPriceEur;
  if (!Number.isFinite(sourcePriceEur) || sourcePriceEur! <= 0) throw new Error("A positive source price is required");
  if (!Number.isFinite(input.engineCc) || input.engineCc <= 0) throw new Error("Engine displacement is required for a preliminary estimate");
  if (input.exchangeRates.source !== "nbrb" || input.exchangeRates.eurByn <= 0) throw new Error("An official NBRB EUR/BYN rate is required");

  const now = input.now ?? new Date();
  const preferential = input.preferential ?? true;
  const band = ageBand(input.firstRegistration, now);
  const ecServiceEur = roundMoney(sourcePriceEur! * EUROPE_BELARUS_PRICING_PROFILE.ecServiceRate);
  const translationEur = roundMoney((sourcePriceEur! + ecServiceEur) * EUROPE_BELARUS_PRICING_PROFILE.translationRate);
  const subtotalEur = roundMoney(sourcePriceEur! + ecServiceEur + translationEur + EUROPE_BELARUS_PRICING_PROFILE.deliveryMinskEur + EUROPE_BELARUS_PRICING_PROFILE.companyServiceEur);
  const fullCustomsDuty = dutyRate(sourcePriceEur!, input.engineCc, band);
  const customsDutyEur = roundMoney(fullCustomsDuty * (preferential ? 0.5 : 1));
  const recyclingFeeByn = band === "up_to_three_years"
    ? EUROPE_BELARUS_PRICING_PROFILE.recyclingFeeByn.upToThreeYears
    : EUROPE_BELARUS_PRICING_PROFILE.recyclingFeeByn.overThreeYears;
  const customsAndRecyclingByn = roundMoney(customsDutyEur * input.exchangeRates.eurByn + recyclingFeeByn);

  return {
    profileVersion: EUROPE_BELARUS_PRICING_PROFILE.version,
    preliminary: true,
    preferential,
    ageBand: band,
    sourcePriceEur: roundMoney(sourcePriceEur!),
    priceBasis: input.priceBasis ?? (input.netPriceEur !== undefined && input.sourcePriceEur === undefined ? "netto" : "brutto"),
    netPriceEur: roundMoney(sourcePriceEur!),
    ecServiceEur,
    translationEur,
    deliveryMinskEur: EUROPE_BELARUS_PRICING_PROFILE.deliveryMinskEur,
    companyServiceEur: EUROPE_BELARUS_PRICING_PROFILE.companyServiceEur,
    customsDutyEur,
    recyclingFeeByn,
    customsAndRecyclingByn,
    subtotalEur,
    totalByn: roundMoney(subtotalEur * input.exchangeRates.eurByn + customsAndRecyclingByn),
    exchangeRates: input.exchangeRates,
  };
}
