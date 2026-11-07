/** Format vehicle power as whole horsepower, rounded to the nearest integer. */
export function formatPowerPs(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(value));
}
