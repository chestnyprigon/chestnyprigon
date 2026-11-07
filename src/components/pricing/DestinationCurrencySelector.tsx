"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { Globe2 } from "lucide-react";

type Destination = "by" | "ru";
type Currency = "USD" | "BYN" | "RUB" | "EUR";

export function DestinationCurrencySelector({ initialDestination, initialCurrency }: { initialDestination: Destination; initialCurrency: Currency }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const query = useMemo(() => new URLSearchParams(search.toString()), [search]);
  const urlDestination = query.get("destination");
  const destination: Destination = urlDestination === "ru" || urlDestination === "by" ? urlDestination : initialDestination;
  const allowed = destination === "ru" ? ["RUB", "USD", "EUR"] : ["USD", "BYN"];
  const urlCurrency = query.get("currency")?.toUpperCase();
  const savedCurrency = urlCurrency ?? initialCurrency;
  const currency = allowed.includes(savedCurrency) ? savedCurrency as Currency : destination === "ru" ? "RUB" : "USD";

  function update(nextDestination: Destination, nextCurrency: Currency) {
    document.cookie = `cp_destination=${nextDestination}; Path=/; Max-Age=31536000; SameSite=Lax`;
    document.cookie = `cp_currency=${nextCurrency}; Path=/; Max-Age=31536000; SameSite=Lax`;
    const params = new URLSearchParams(search.toString());
    params.set("destination", nextDestination);
    params.set("currency", nextCurrency);
    router.push(`${pathname}${params.size ? `?${params.toString()}` : ""}`, { scroll: false });
  }

  const currencies: Currency[] = destination === "ru" ? ["RUB", "USD", "EUR"] : ["USD", "BYN"];
  return <div className="destination-currency-bar destination-currency-hero" aria-label="Страна назначения и валюта">
    <strong className="destination-currency-title"><Globe2 size={18} />Страна и валюта</strong>
    <label><span>Страна назначения</span><select value={destination} onChange={(event) => { const next = event.target.value as Destination; update(next, next === "ru" ? "RUB" : "USD"); }}>
      <option value="by">Беларуси</option><option value="ru">России</option>
    </select></label>
    <label><span>Валюта</span><select value={currency} onChange={(event) => update(destination, event.target.value as Currency)}>
      {currencies.map((item) => <option key={item} value={item}>{item}</option>)}
    </select></label>
  </div>;
}
