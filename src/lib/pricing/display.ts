import type { ExchangeRates } from "./chestny-prigon-profile";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const byn = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

export function formatUsdWithByn(value: number | null, rates: ExchangeRates) {
  if (value === null) return "Расчёт уточняется";
  return `${usd.format(value)} (≈ ${byn.format(Math.round(value * rates.usdByn))} BYN)`;
}

export function formatBelarusCurrencyPair(valueUsd: number | null, rates: ExchangeRates, currency: "USD" | "BYN") {
  if (valueUsd === null) return "Расчёт уточняется";
  const valueByn = Math.round(valueUsd * rates.usdByn);
  return currency === "BYN"
    ? `${byn.format(valueByn)} BYN (≈ ${usd.format(valueUsd)})`
    : `${usd.format(valueUsd)} (≈ ${byn.format(valueByn)} BYN)`;
}

/** Displays a source amount in KRW as its USD equivalent using the active KRW/USD rate. */
export function formatKrwAsUsd(amountKrw: number, krwPerUsd: number) {
  if (!Number.isFinite(amountKrw) || !Number.isFinite(krwPerUsd) || krwPerUsd <= 0) {
    return "Нет данных";
  }
  return usd.format(Math.round(amountKrw / krwPerUsd));
}
