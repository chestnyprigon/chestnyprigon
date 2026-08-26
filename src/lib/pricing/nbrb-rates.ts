import type { ExchangeRates } from "./chestny-prigon-profile";

export const NBRB_DAILY_URL = "https://api.nbrb.by/exrates/rates?periodicity=0";

function decimal(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Official daily rates used to convert Belarusian statutory payments. */
export async function fetchNbrbRates(): Promise<ExchangeRates> {
  const response = await fetch(NBRB_DAILY_URL, { next: { revalidate: 86_400 } });
  if (!response.ok) throw new Error(`NBRB returned ${response.status}`);
  const rows = await response.json() as Array<{ Cur_Abbreviation?: string; Cur_OfficialRate?: number; Cur_Scale?: number; Date?: string }>;
  const find = (currency: string) => rows.find((row) => row.Cur_Abbreviation === currency);
  const usd = find("USD");
  const eur = find("EUR");
  const usdByn = decimal(usd?.Cur_OfficialRate) && decimal(usd?.Cur_Scale) ? Number(usd!.Cur_OfficialRate) / Number(usd!.Cur_Scale) : null;
  const eurByn = decimal(eur?.Cur_OfficialRate) && decimal(eur?.Cur_Scale) ? Number(eur!.Cur_OfficialRate) / Number(eur!.Cur_Scale) : null;
  if (!usdByn || !eurByn) throw new Error("NBRB daily USD/EUR rates are unavailable");
  return { usdByn, eurByn, rateDate: (usd?.Date ?? new Date().toISOString()).slice(0, 10), source: "nbrb" };
}
