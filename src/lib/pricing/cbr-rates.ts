import "server-only";

export type RubExchangeRates = Record<"EUR" | "USD", number>;

export async function fetchCbrRates(): Promise<RubExchangeRates | null> {
  try {
    const response = await fetch("https://www.cbr.ru/scripts/XML_daily.asp", {
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;

    // The feed uses Windows-1251. Currency codes and numeric fields are ASCII.
    const xml = await response.text();
    const entries = [...xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g)].map((match) => match[1]!);
    const read = (code: "EUR" | "USD") => {
      const entry = entries.find((item) => item.includes(`<CharCode>${code}</CharCode>`));
      const nominal = Number(entry?.match(/<Nominal>(\d+)<\/Nominal>/)?.[1]);
      const amount = Number(entry?.match(/<Value>([\d,]+)<\/Value>/)?.[1]?.replace(",", "."));
      return amount / nominal;
    };
    const EUR = read("EUR");
    const USD = read("USD");
    return Number.isFinite(EUR) && EUR > 0 && Number.isFinite(USD) && USD > 0 ? { EUR, USD } : null;
  } catch {
    return null;
  }
}
