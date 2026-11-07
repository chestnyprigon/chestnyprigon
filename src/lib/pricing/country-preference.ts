import "server-only";
import { cookies } from "next/headers";

export type CalculationDestination = "by" | "ru";
export type DisplayCurrency = "USD" | "BYN" | "RUB" | "EUR";

export async function readCalculationPreference(params: Record<string, string | string[] | undefined> = {}) {
  const cookieStore = await cookies();
  const destinationParam = typeof params.destination === "string" ? params.destination : null;
  const destinationCookie = cookieStore.get("cp_destination")?.value;
  const destination: CalculationDestination = destinationParam === "ru" || destinationParam === "by"
    ? destinationParam
    : destinationCookie === "ru" ? "ru" : "by";
  const currencyParam = typeof params.currency === "string" ? params.currency.toUpperCase() : null;
  const currencyCookie = cookieStore.get("cp_currency")?.value.toUpperCase();
  const candidate = currencyParam ?? currencyCookie;
  const allowed: DisplayCurrency[] = destination === "ru" ? ["RUB", "USD", "EUR"] : ["USD", "BYN"];
  const currency = allowed.includes(candidate as DisplayCurrency)
    ? candidate as DisplayCurrency
    : destination === "ru" ? "RUB" : "USD";
  return { destination, currency } as const;
}
