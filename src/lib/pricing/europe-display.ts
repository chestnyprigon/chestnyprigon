import { formatRussiaRubAmount, formatRussiaTotal, type RussiaPriceResult } from "./russia-pricing";
import type { RubExchangeRates } from "./cbr-rates";

export function formatEuropeRussiaPrice(
  sourceEur: number | null | undefined,
  currency: "USD" | "BYN" | "RUB" | "EUR",
  calculation: RussiaPriceResult | null | undefined,
  rates: RubExchangeRates | null | undefined,
) {
  const selected = currency === "BYN" ? "RUB" : currency;
  if (calculation) return formatRussiaTotal(calculation, selected);
  if (typeof sourceEur !== "number" || !Number.isFinite(sourceEur) || sourceEur <= 0) return "";
  if (rates) return formatRussiaRubAmount(sourceEur * rates.EUR, selected, rates);
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(sourceEur);
}

/** Shared presentation for preliminary Europe turnkey totals. */
export function formatEuropeTurnkeyPrice(totalByn: number, eurByn: number) {
  if (!Number.isFinite(totalByn) || totalByn <= 0 || !Number.isFinite(eurByn) || eurByn <= 0) return "";
  const eur = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(totalByn / eurByn);
  const byn = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(totalByn));
  return `${eur} (≈ ${byn} BYN)`;
}

/** Displays a Belarus turnkey amount using the selected Belarus currency first. */
export function formatEuropeBelarusPrice(totalByn: number, usdByn: number, currency: "USD" | "BYN") {
  if (!Number.isFinite(totalByn) || totalByn <= 0 || !Number.isFinite(usdByn) || usdByn <= 0) return "";
  const byn = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(totalByn));
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(totalByn / usdByn);
  return currency === "BYN" ? `${byn} BYN (≈ ${usd})` : `${usd} (≈ ${byn} BYN)`;
}

/** Displays a Mobile.de source price with an approximate BYN conversion. */
export function formatEuropeSourcePrice(sourceEur: number, eurByn: number) {
  if (!Number.isFinite(sourceEur) || sourceEur <= 0 || !Number.isFinite(eurByn) || eurByn <= 0) return "";
  const eur = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(sourceEur);
  const byn = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(sourceEur * eurByn));
  return `${eur} (≈ ${byn} BYN)`;
}
