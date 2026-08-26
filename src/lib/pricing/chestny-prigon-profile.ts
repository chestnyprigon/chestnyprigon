export type PricingProfile = {
  version: string;
  krwPerUsd: number;
  deliveryUsd: number;
  commissionRate: number;
  svhDeclarantEur: number;
  customsClearanceEur: number;
  companyServiceUsd: number;
};

export type ExchangeRates = {
  usdByn: number;
  eurByn: number;
  rateDate: string;
  source: "nbrb" | "fallback";
};

export const CHESTNY_PRIGON_PRICING_PROFILE: PricingProfile = {
  version: "chestny-prigon-client-table-v2-dynamic-state-fees",
  // Commercial KRW/USD rate is supplied and approved by the client.
  krwPerUsd: 1397,
  deliveryUsd: 4_700,
  commissionRate: 0.025,
  svhDeclarantEur: 150,
  // Commercial handling and accompaniment tariff, not a statutory customs fee.
  customsClearanceEur: 400,
  companyServiceUsd: 300,
};

const PERSONAL_IMPORT_UTILIZATION_FEE_BYN = {
  upToThreeYears: 624.92,
  overThreeYears: 1_282.02,
} as const;

// Used only when the official daily cache cannot be read. It is deliberately
// labelled as a fallback in the UI and is replaced by the NBRB cache server-side.
export const FALLBACK_EXCHANGE_RATES: ExchangeRates = {
  usdByn: 2.9829,
  eurByn: 3.4918,
  rateDate: "2026-08-23",
  source: "fallback",
};

export type BelarusPriceInput = {
  priceKrw: number;
  engineCc: number | null;
  firstRegistrationDate: string | null;
  fuelType: string;
  preferential?: boolean;
  now?: Date;
  profile?: PricingProfile;
  exchangeRates?: ExchangeRates;
};

export type BelarusPriceCalculation = {
  profileVersion: string;
  preliminary: true;
  preferential: boolean;
  ageMonths: number | null;
  calculationAvailable: boolean;
  unavailableReason: string | null;
  sourcePriceKrw: number;
  krwPerUsd: number;
  sourcePriceUsd: number;
  sourcePriceEur: number;
  deliveryUsd: number;
  commissionUsd: number;
  firstPaymentUsd: number;
  svhDeclarantEur: number;
  customsDutyEur: number | null;
  customsClearanceEur: number;
  utilizationFeeByn: number | null;
  arrivalMinskEur: number | null;
  companyServiceUsd: number;
  totalUsd: number | null;
  eurPerUsd: number;
  rates: ExchangeRates;
};

function monthsBetween(registration: string | null, now: Date) {
  if (!registration) return null;
  const date = new Date(`${registration.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) return null;
  let months = (now.getUTCFullYear() - date.getUTCFullYear()) * 12 + now.getUTCMonth() - date.getUTCMonth();
  if (now.getUTCDate() < date.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

type VehicleAgeBand = "up_to_three_years" | "three_to_five_years" | "over_five_years";

function vehicleAgeBand(registration: string | null, now: Date): VehicleAgeBand | null {
  if (!registration) return null;
  const date = new Date(`${registration.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) return null;
  const atMost = (years: number) => now.getTime() <= Date.UTC(
    date.getUTCFullYear() + years,
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  if (atMost(3)) return "up_to_three_years";
  if (atMost(5)) return "three_to_five_years";
  return "over_five_years";
}

function isElectricOrNonStandardFuel(fuelType: string) {
  const fuel = fuelType.toLowerCase();
  const isHybrid = /하이브리드|hybrid|hev|phev|plug[ -]?in|가솔린\s*\+\s*전기|디젤\s*\+\s*전기/u.test(fuel);
  const isHydrogen = fuel.includes("수소") || fuel.includes("hydrogen");
  const isElectric = !isHybrid && (fuel.includes("전기") || fuel.includes("electric") || fuel.includes("электро"));
  return isElectric || isHydrogen;
}

function rateForDisplacement(engineCc: number, rates: Array<[number, number]>) {
  return rates.find(([limit]) => engineCc <= limit)?.[1] ?? rates.at(-1)![1];
}

function customsDutyEur({ priceEur, engineCc, ageBand, preferential }: { priceEur: number; engineCc: number | null; ageBand: VehicleAgeBand | null; preferential: boolean }) {
  if (!engineCc || engineCc <= 0 || ageBand === null) return null;
  let dutyEur: number;
  if (ageBand === "up_to_three_years") {
    const brackets: Array<[number, number, number]> = [
      [8_500, 0.54, 2.5], [16_700, 0.48, 3.5], [42_300, 0.48, 5.5],
      [84_500, 0.48, 7.5], [169_000, 0.48, 15], [Number.POSITIVE_INFINITY, 0.48, 20],
    ];
    const [, percent, euroPerCc] = brackets.find(([limit]) => priceEur <= limit)!;
    dutyEur = Math.max(priceEur * percent, engineCc * euroPerCc);
  } else if (ageBand === "three_to_five_years") {
    dutyEur = engineCc * rateForDisplacement(engineCc, [[1_000, 1.5], [1_500, 1.7], [1_800, 2.5], [2_300, 2.7], [3_000, 3], [Infinity, 3.6]]);
  } else {
    dutyEur = engineCc * rateForDisplacement(engineCc, [[1_000, 3], [1_500, 3.2], [1_800, 3.5], [2_300, 4.8], [3_000, 5], [Infinity, 5.7]]);
  }
  return Math.round(dutyEur * (preferential ? 0.5 : 1));
}

function utilizationFeeByn(ageBand: VehicleAgeBand | null) {
  if (ageBand === null) return null;
  return ageBand === "up_to_three_years"
    ? PERSONAL_IMPORT_UTILIZATION_FEE_BYN.upToThreeYears
    : PERSONAL_IMPORT_UTILIZATION_FEE_BYN.overThreeYears;
}

export function calculateBelarusPrice(input: BelarusPriceInput): BelarusPriceCalculation {
  if (!Number.isFinite(input.priceKrw) || input.priceKrw <= 0) throw new Error("priceKrw must be a positive number");
  const profile = input.profile ?? CHESTNY_PRIGON_PRICING_PROFILE;
  const rates = input.exchangeRates ?? FALLBACK_EXCHANGE_RATES;
  if (rates.usdByn <= 0 || rates.eurByn <= 0 || profile.krwPerUsd <= 0) throw new Error("pricing rates must be positive");

  const preferential = input.preferential ?? false;
  const now = input.now ?? new Date();
  const ageMonths = monthsBetween(input.firstRegistrationDate, now);
  const ageBand = vehicleAgeBand(input.firstRegistrationDate, now);
  const eurPerUsd = rates.eurByn / rates.usdByn;
  const sourcePriceUsd = Math.round(input.priceKrw / profile.krwPerUsd);
  const sourcePriceEur = Math.round(sourcePriceUsd / eurPerUsd);
  const commissionUsd = Math.round((sourcePriceUsd + profile.deliveryUsd) * profile.commissionRate);
  const firstPaymentUsd = sourcePriceUsd + profile.deliveryUsd + commissionUsd;
  const unavailableReason = !input.firstRegistrationDate
    ? "Не указана дата первой регистрации"
    : isElectricOrNonStandardFuel(input.fuelType)
      ? "Для этого типа силовой установки расчёт таможенной пошлины уточняется"
      : !input.engineCc || input.engineCc <= 0
        ? "Не указан объём двигателя"
        : null;
  const dutyEur = unavailableReason ? null : customsDutyEur({ priceEur: sourcePriceEur, engineCc: input.engineCc, ageBand, preferential });
  const utilizationByn = dutyEur === null ? null : utilizationFeeByn(ageBand);
  const arrivalMinskEur = dutyEur === null || utilizationByn === null
    ? null
    : Math.round(profile.svhDeclarantEur + dutyEur + profile.customsClearanceEur + utilizationByn / rates.eurByn);
  const totalUsd = arrivalMinskEur === null ? null : Math.round(firstPaymentUsd + arrivalMinskEur / eurPerUsd + profile.companyServiceUsd);

  return {
    profileVersion: profile.version,
    preliminary: true,
    preferential,
    ageMonths,
    calculationAvailable: totalUsd !== null,
    unavailableReason,
    sourcePriceKrw: input.priceKrw,
    krwPerUsd: profile.krwPerUsd,
    sourcePriceUsd,
    sourcePriceEur,
    deliveryUsd: profile.deliveryUsd,
    commissionUsd,
    firstPaymentUsd,
    svhDeclarantEur: profile.svhDeclarantEur,
    customsDutyEur: dutyEur,
    customsClearanceEur: profile.customsClearanceEur,
    utilizationFeeByn: utilizationByn,
    arrivalMinskEur,
    companyServiceUsd: profile.companyServiceUsd,
    totalUsd,
    eurPerUsd,
    rates,
  };
}
