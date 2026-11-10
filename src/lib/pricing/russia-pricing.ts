import type { VehiclePowerTksResult } from "@/lib/pricing/vehicle-power-tks";

export const RUSSIA_KOREA_COMMERCIAL_PROFILE = {
  id: "ru-korea-commercial-v1",
  parkingKrw: 440_000,
  deliveryUsd: 4_900,
  commissionRate: 0.02,
  svhDeclarantEur: 150,
  companyServiceUsd: 300,
} as const;

export const RUSSIA_EUROPE_COMMERCIAL_PROFILE = {
  id: "ru-europe-commercial-v1",
  euServiceRate: 0.025,
  translationRate: 0.015,
  deliveryEur: 2_200,
  companyServiceEur: 1_000,
} as const;

export type RussiaCommercialResult = {
  profileId: string;
  currency: "RUB";
  sourcePriceRub: number;
  sourcePriceAmount: number;
  sourceCurrency: "KRW" | "EUR";
  exchangeRates: Record<string, number>;
  lineItemsRub: Record<string, number>;
  subtotalRub: number;
};

export type RussiaPriceResult = {
  destination: "RU";
  currency: "RUB";
  preliminary: true;
  totalRub: number;
  commercial: RussiaCommercialResult;
  rates: { rubPerUnit: Record<string, number>; effectiveDate: string; fetchedAt: string; source: string };
  tks: { engine: string; rulesVersion: string; calculationDate: string; estimatedClearanceDate: string };
  power: {
    calculationPowerKw: number;
    calculationBasis: string;
    calculationRule: string;
    confidence: "CONFIRMED" | "PROBABLE" | "ESTIMATED";
    sourceRef: string;
    researchRef: string | null;
    components: Record<string, number | null>;
  };
  powerContext: VehiclePowerTksResult["powerContext"] | null;
  government: {
    customsValueRub: number;
    dutyRub: number;
    exciseRub: number;
    vatRub: number;
    recyclingFeeRub: number;
    customsProcessingFeeRub: number;
    officialSubtotalRub: number;
    rulesVersion: string;
  };
};

/** Keep only the current client breakdown and compact calculation provenance in the database. */
export function compactRussiaPriceSnapshot(result: RussiaPriceResult): RussiaPriceResult {
  return {
    ...result,
    powerContext: null,
    power: {
      ...result.power,
      sourceRef: result.power.sourceRef.slice(0, 160),
      researchRef: result.power.researchRef?.slice(0, 160) ?? null,
    },
  };
}

export function formatRussiaRubAmount(amount: number, currency: "RUB" | "USD" | "EUR", rubPerUnit: Record<string, number>) {
  const rub = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(amount);
  if (currency === "RUB") return rub;
  const rate = rubPerUnit[currency];
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return rub;
  const display = new Intl.NumberFormat("ru-RU", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount / rate);
  return `${display} (${rub})`;
}

export function formatRussiaTotal(result: RussiaPriceResult, currency: "RUB" | "USD" | "EUR" = "RUB") {
  return formatRussiaRubAmount(result.totalRub, currency, result.rates.rubPerUnit);
}

const roundRub = (value: number) => Math.round(value * 100) / 100;
const positive = (value: number, name: string) => {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
};

/** Reuses the approved Korea commercial baseline while keeping Russian statutory charges separate. */
export function calculateRussiaKoreaCommercial(input: {
  priceKrw: number;
  krwPerUsd: number;
  rubPerUsd: number;
  rubPerEur: number;
}): RussiaCommercialResult {
  const priceKrw = positive(input.priceKrw, "priceKrw");
  const krwPerUsd = positive(input.krwPerUsd, "krwPerUsd");
  const rubPerUsd = positive(input.rubPerUsd, "rubPerUsd");
  const rubPerEur = positive(input.rubPerEur, "rubPerEur");
  const sourcePriceUsd = Math.round(priceKrw / krwPerUsd);
  const koreaCostUsd = Math.round((priceKrw + RUSSIA_KOREA_COMMERCIAL_PROFILE.parkingKrw) / krwPerUsd);
  const commissionUsd = Math.round((sourcePriceUsd + RUSSIA_KOREA_COMMERCIAL_PROFILE.deliveryUsd) * RUSSIA_KOREA_COMMERCIAL_PROFILE.commissionRate);
  const lineItemsRub = {
    vehicleAndKoreaCost: roundRub(koreaCostUsd * rubPerUsd),
    delivery: roundRub(RUSSIA_KOREA_COMMERCIAL_PROFILE.deliveryUsd * rubPerUsd),
    commission: roundRub(commissionUsd * rubPerUsd),
    svhDeclarant: roundRub(RUSSIA_KOREA_COMMERCIAL_PROFILE.svhDeclarantEur * rubPerEur),
    companyService: roundRub(RUSSIA_KOREA_COMMERCIAL_PROFILE.companyServiceUsd * rubPerUsd),
  };
  return {
    profileId: RUSSIA_KOREA_COMMERCIAL_PROFILE.id,
    currency: "RUB",
    sourcePriceRub: roundRub(priceKrw / krwPerUsd * rubPerUsd),
    sourcePriceAmount: priceKrw,
    sourceCurrency: "KRW",
    exchangeRates: { KRW_per_USD: krwPerUsd, RUB_per_USD: rubPerUsd, RUB_per_EUR: rubPerEur },
    lineItemsRub,
    subtotalRub: roundRub(Object.values(lineItemsRub).reduce((sum, amount) => sum + amount, 0)),
  };
}

/** Preliminary Europe commercial baseline; Belarus-only recycling and customs lines are omitted. */
export function calculateRussiaEuropeCommercial(input: {
  netPriceEur: number;
  rubPerEur: number;
}): RussiaCommercialResult {
  const netPriceEur = positive(input.netPriceEur, "netPriceEur");
  const rubPerEur = positive(input.rubPerEur, "rubPerEur");
  const euServiceEur = roundRub(netPriceEur * RUSSIA_EUROPE_COMMERCIAL_PROFILE.euServiceRate);
  const translationEur = roundRub((netPriceEur + euServiceEur) * RUSSIA_EUROPE_COMMERCIAL_PROFILE.translationRate);
  const lineItemsRub = {
    vehicle: roundRub(netPriceEur * rubPerEur),
    euService: roundRub(euServiceEur * rubPerEur),
    translation: roundRub(translationEur * rubPerEur),
    delivery: roundRub(RUSSIA_EUROPE_COMMERCIAL_PROFILE.deliveryEur * rubPerEur),
    companyService: roundRub(RUSSIA_EUROPE_COMMERCIAL_PROFILE.companyServiceEur * rubPerEur),
  };
  return {
    profileId: RUSSIA_EUROPE_COMMERCIAL_PROFILE.id,
    currency: "RUB",
    sourcePriceRub: roundRub(netPriceEur * rubPerEur),
    sourcePriceAmount: netPriceEur,
    sourceCurrency: "EUR",
    exchangeRates: { RUB_per_EUR: rubPerEur },
    lineItemsRub,
    subtotalRub: roundRub(Object.values(lineItemsRub).reduce((sum, amount) => sum + amount, 0)),
  };
}

/** Combines the commercial profile with the TKS statutory result exactly once. */
export function combineRussiaPrice(commercial: RussiaCommercialResult, tks: VehiclePowerTksResult): RussiaPriceResult {
  const government = {
    customsValueRub: tks.customsValueRub,
    dutyRub: tks.dutyRub,
    exciseRub: tks.exciseRub,
    vatRub: tks.vatRub,
    recyclingFeeRub: tks.recyclingFeeRub,
    customsProcessingFeeRub: tks.customsProcessingFeeRub,
    officialSubtotalRub: tks.officialSubtotalRub,
    rulesVersion: tks.rulesVersion,
  };
  return {
    destination: "RU",
    currency: "RUB",
    preliminary: true,
    totalRub: Math.round(commercial.subtotalRub + government.officialSubtotalRub),
    commercial,
    rates: tks.rates,
    tks: { engine: tks.engine, rulesVersion: tks.rulesVersion, calculationDate: tks.calculationDate, estimatedClearanceDate: tks.estimatedClearanceDate },
    power: {
      calculationPowerKw: tks.power.calculationPowerKw,
      calculationBasis: tks.power.calculationBasis,
      calculationRule: tks.power.calculationRule,
      confidence: tks.power.confidence,
      sourceRef: tks.power.sourceRef,
      researchRef: tks.power.researchRef,
      components: tks.power.components,
    },
    powerContext: tks.powerContext ?? null,
    government,
  };
}
