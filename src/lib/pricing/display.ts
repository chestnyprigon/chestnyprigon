import type { ExchangeRates } from "./chestny-prigon-profile";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const byn = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

export function formatUsdWithByn(value: number | null, rates: ExchangeRates) {
  if (value === null) return "Расчёт уточняется";
  return `${usd.format(value)} (≈ ${byn.format(Math.round(value * rates.usdByn))} BYN)`;
}
