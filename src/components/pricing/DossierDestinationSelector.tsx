"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";

type Destination = "by" | "ru";
type Currency = "USD" | "BYN" | "RUB" | "EUR";

const currencies: Record<Destination, Currency[]> = {
  by: ["USD", "BYN"],
  ru: ["RUB", "USD", "EUR"],
};

export function DossierDestinationSelector({
  initialDestination,
  initialCurrency,
}: {
  initialDestination: Destination;
  initialCurrency: Currency;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const query = useMemo(() => new URLSearchParams(search.toString()), [search]);
  const destination: Destination = query.get("destination") === "ru" || query.get("destination") === "by"
    ? query.get("destination") as Destination
    : initialDestination;
  const queryCurrency = query.get("currency")?.toUpperCase();
  const currency = currencies[destination].includes(queryCurrency as Currency)
    ? queryCurrency as Currency
    : currencies[destination].includes(initialCurrency) ? initialCurrency : destination === "ru" ? "RUB" : "USD";

  function update(nextDestination: Destination, nextCurrency: Currency) {
    document.cookie = `cp_destination=${nextDestination}; Path=/; Max-Age=31536000; SameSite=Lax`;
    document.cookie = `cp_currency=${nextCurrency}; Path=/; Max-Age=31536000; SameSite=Lax`;
    const params = new URLSearchParams(search.toString());
    params.set("destination", nextDestination);
    params.set("currency", nextCurrency);
    router.push(`${pathname}${params.size ? `?${params.toString()}` : ""}`, { scroll: false });
  }

  return (
    <div className="dossier-destination-selector" aria-label="Регион и валюта расчёта">
      <label>
        <span>Доставка и расчёт</span>
        <select
          aria-label="Страна и город доставки"
          value={destination}
          onChange={(event) => {
            const next = event.target.value as Destination;
            update(next, next === "ru" ? "RUB" : "USD");
          }}
        >
          <option value="by">Беларусь · Минск</option>
          <option value="ru">Россия · Москва</option>
        </select>
      </label>
      <label>
        <span>Валюта</span>
        <select
          aria-label="Валюта расчёта"
          value={currency}
          onChange={(event) => update(destination, event.target.value as Currency)}
        >
          {currencies[destination].map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </label>
    </div>
  );
}
