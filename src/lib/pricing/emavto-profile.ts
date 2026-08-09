export const EMAVTO_PRELIMINARY_PROFILE = {
  version: "emavto-har-2026-08-07-v1",
  capturedAt: "2026-08-07",
  rates: {
    krwPerUsd: 1406,
    krwPerEur: 1608,
    eurPerUsd: 0.8664,
    rubPerUsd: 80.93,
  },
  costs: {
    koreaFixedKrw: 1_200_000,
    koreaFeeMultiplier: 1.01 * 1.02,
    exportExtraUsd: 1060,
    deliveryUsd: 4050,
    transitRub: 140_000,
    customsServicesUsd: 600,
    companyServicesUsd: 300,
  },
} as const;

export type BelarusPriceInput = {
  priceKrw: number;
  engineCc: number | null;
  firstRegistrationDate: string | null;
  fuelType: string;
  preferential?: boolean;
  now?: Date;
};

export type BelarusPriceCalculation = {
  profileVersion: string;
  preliminary: true;
  preferential: boolean;
  ageMonths: number | null;
  sourcePriceUsd: number;
  koreaAndExportUsd: number;
  deliveryUsd: number;
  transitUsd: number;
  customsDutyUsd: number;
  customsServicesUsd: number;
  companyServicesUsd: number;
  totalUsd: number;
};

function monthsBetween(registration: string | null, now: Date) {
  if (!registration) return null;
  const date = new Date(`${registration.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) return null;
  let months =
    (now.getUTCFullYear() - date.getUTCFullYear()) * 12 +
    now.getUTCMonth() -
    date.getUTCMonth();
  if (now.getUTCDate() < date.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

function isElectric(fuelType: string) {
  const fuel = fuelType.toLowerCase();
  return fuel.includes("전기") || fuel.includes("electric") || fuel.includes("электро");
}

function rateForDisplacement(engineCc: number, rates: Array<[number, number]>) {
  return rates.find(([limit]) => engineCc < limit)?.[1] ?? rates.at(-1)![1];
}

function customsDutyUsd({
  priceKrw,
  engineCc,
  ageMonths,
  fuelType,
  preferential,
}: {
  priceKrw: number;
  engineCc: number | null;
  ageMonths: number | null;
  fuelType: string;
  preferential: boolean;
}) {
  if (isElectric(fuelType)) return 0;
  if (!engineCc || engineCc <= 0 || ageMonths === null) return 0;

  const { krwPerEur, eurPerUsd } = EMAVTO_PRELIMINARY_PROFILE.rates;
  const koreanTaxAdjustment = (priceKrw / 1.1) * 0.1 * 0.4;
  let dutyUsd: number;

  if (ageMonths < 36) {
    const customsValueEur = Math.round((priceKrw - koreanTaxAdjustment) / krwPerEur);
    const brackets: Array<[number, number, number]> = [
      [8500, 0.54, 2.5],
      [16_700, 0.48, 3.5],
      [42_300, 0.48, 5.5],
      [84_500, 0.48, 7.5],
      [169_000, 0.48, 15],
      [Number.POSITIVE_INFINITY, 0.48, 20],
    ];
    const [, percent, euroPerCc] = brackets.find(([limit]) => customsValueEur <= limit)!;
    const dutyEur = Math.max(engineCc * euroPerCc, customsValueEur * percent);
    dutyUsd = Math.round(dutyEur / eurPerUsd);
  } else if (ageMonths <= 60) {
    const euroPerCc = rateForDisplacement(engineCc, [
      [1000, 1.5],
      [1500, 1.7],
      [1800, 2.5],
      [2300, 2.7],
      [3000, 3],
      [Number.POSITIVE_INFINITY, 3.6],
    ]);
    dutyUsd = Math.round((engineCc * euroPerCc) / eurPerUsd);
  } else {
    const euroPerCc = rateForDisplacement(engineCc, [
      [1000, 3],
      [1500, 3.2],
      [1800, 3.5],
      [2300, 4.8],
      [3000, 5],
      [Number.POSITIVE_INFINITY, 5.7],
    ]);
    dutyUsd = Math.round((engineCc * euroPerCc) / eurPerUsd);
  }

  return preferential ? Math.round(dutyUsd * 0.5) : dutyUsd;
}

export function calculateBelarusPrice(input: BelarusPriceInput): BelarusPriceCalculation {
  if (!Number.isFinite(input.priceKrw) || input.priceKrw <= 0) {
    throw new Error("priceKrw must be a positive number");
  }
  if (!input.firstRegistrationDate) {
    throw new Error("firstRegistrationDate is required for customs calculation");
  }
  if (!isElectric(input.fuelType) && (!input.engineCc || input.engineCc <= 0)) {
    throw new Error("engineCc is required for a non-electric customs calculation");
  }

  const profile = EMAVTO_PRELIMINARY_PROFILE;
  const preferential = input.preferential ?? true;
  const ageMonths = monthsBetween(input.firstRegistrationDate, input.now ?? new Date());
  const koreanTaxAdjustment = (input.priceKrw / 1.1) * 0.1 * 0.4;
  const adjustedKrw =
    (input.priceKrw - koreanTaxAdjustment + profile.costs.koreaFixedKrw) *
    profile.costs.koreaFeeMultiplier;
  const koreaAndExportUsd =
    Math.round(adjustedKrw / profile.rates.krwPerUsd) + profile.costs.exportExtraUsd;
  const transitUsd = Math.round(profile.costs.transitRub / profile.rates.rubPerUsd);
  const duty = customsDutyUsd({
    priceKrw: input.priceKrw,
    engineCc: input.engineCc,
    ageMonths,
    fuelType: input.fuelType,
    preferential,
  });
  const totalUsd =
    koreaAndExportUsd +
    profile.costs.deliveryUsd +
    transitUsd +
    duty +
    profile.costs.customsServicesUsd +
    profile.costs.companyServicesUsd;

  return {
    profileVersion: profile.version,
    preliminary: true,
    preferential,
    ageMonths,
    sourcePriceUsd: Math.round(input.priceKrw / profile.rates.krwPerUsd),
    koreaAndExportUsd,
    deliveryUsd: profile.costs.deliveryUsd,
    transitUsd,
    customsDutyUsd: duty,
    customsServicesUsd: profile.costs.customsServicesUsd,
    companyServicesUsd: profile.costs.companyServicesUsd,
    totalUsd,
  };
}
