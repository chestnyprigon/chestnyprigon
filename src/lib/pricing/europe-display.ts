/** Shared presentation for preliminary Europe turnkey totals. */
export function formatEuropeTurnkeyPrice(totalByn: number, eurByn: number) {
  if (!Number.isFinite(totalByn) || totalByn <= 0 || !Number.isFinite(eurByn) || eurByn <= 0) return "";
  const eur = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(totalByn / eurByn);
  const byn = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(totalByn));
  return `${eur} (≈ ${byn} BYN)`;
}

/** Displays a Mobile.de source price with an approximate BYN conversion. */
export function formatEuropeSourcePrice(sourceEur: number, eurByn: number) {
  if (!Number.isFinite(sourceEur) || sourceEur <= 0 || !Number.isFinite(eurByn) || eurByn <= 0) return "";
  const eur = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(sourceEur);
  const byn = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(sourceEur * eurByn));
  return `${eur} (≈ ${byn} BYN)`;
}
