"use client";

import { type FormEvent, useMemo, useState } from "react";
import { ArrowRight, Calculator, Check, ExternalLink, ShieldCheck } from "lucide-react";
import { calculateEuropeBelarusPrice } from "@/lib/pricing/europe-belarus";
import { formatEuropeRussiaPrice, formatEuropeSourcePrice, formatEuropeTurnkeyPrice } from "@/lib/pricing/europe-display";
import type { ExchangeRates } from "@/lib/pricing/chestny-prigon-profile";
import type { MobileDeListing } from "@/lib/mobile-de/types";
import { vehicleDisplayName } from "@/lib/mobile-de/models";
import { CatalogPrice } from "@/components/catalog/CatalogPrice";
import { InfoTooltip } from "./InfoTooltip";
import type { RussiaPriceResult } from "@/lib/pricing/russia-pricing";
import type { RubExchangeRates } from "@/lib/pricing/cbr-rates";
import { RussiaPriceBreakdown } from "@/components/pricing/RussiaPriceBreakdown";

const money = (amount: number, currency: "EUR" | "BYN") => new Intl.NumberFormat("ru-RU", {
  style: "currency", currency, maximumFractionDigits: 2,
}).format(amount);

function sourceUrl(sourceId: string) {
  const url = new URL("https://suchen.mobile.de/fahrzeuge/details.html");
  url.searchParams.set("id", sourceId);
  return url.toString();
}

export function MobileDePriceCalculator({ listing, exchangeRates, destination = "by", currency = "USD", russiaCalculation = null, rubRates }: {
  listing: MobileDeListing;
  exchangeRates: ExchangeRates | null;
  destination?: "by" | "ru";
  currency?: "USD" | "BYN" | "RUB" | "EUR";
  russiaCalculation?: RussiaPriceResult | null;
  rubRates?: RubExchangeRates | null;
}) {
  const [preferential, setPreferential] = useState(true);
  const [liveRussiaCalculation, setLiveRussiaCalculation] = useState<RussiaPriceResult | null>(null);
  const [isRussiaRefreshing, setRussiaRefreshing] = useState(false);
  const [russiaRefreshError, setRussiaRefreshError] = useState<string | null>(null);
  const [leadOpen, setLeadOpen] = useState(false);
  const [leadSent, setLeadSent] = useState(false);
  const [leadSending, setLeadSending] = useState(false);
  const [leadError, setLeadError] = useState("");
  const isVan = listing.transport_class === "VAN";
  const amount = listing.price?.amount;
  const firstRegistration = listing.first_registration?.value;
  const calculation = useMemo(() => {
    if (isVan || !exchangeRates || exchangeRates.source !== "nbrb" || amount == null || !firstRegistration || !listing.engine_cc) return null;
    return calculateEuropeBelarusPrice({ sourcePriceEur: amount, priceBasis: listing.price?.basis ?? "unknown", firstRegistration, engineCc: listing.engine_cc, preferential, exchangeRates });
  }, [amount, exchangeRates, isVan, listing.engine_cc, listing.price?.basis, preferential, firstRegistration]);
  const title = vehicleDisplayName(listing.make, listing.model, listing.title).name;
  const source = sourceUrl(listing.source_id);
  const activeRussiaCalculation = liveRussiaCalculation ?? russiaCalculation;
  const formattedTotal = destination === "ru"
    ? formatEuropeRussiaPrice(amount, currency, isVan ? null : activeRussiaCalculation, rubRates)
    : calculation && exchangeRates ? formatEuropeTurnkeyPrice(calculation.totalByn, exchangeRates.eurByn)
      : amount != null ? exchangeRates ? formatEuropeSourcePrice(amount, exchangeRates.eurByn) : money(amount, "EUR") : "—";
  const hasTurnkeyTotal = !isVan && (destination === "ru" ? Boolean(activeRussiaCalculation) : Boolean(calculation));

  async function refreshRussiaPrice() {
    setRussiaRefreshing(true);
    setRussiaRefreshError(null);
    try {
      const response = await fetch("/api/catalog/russia-price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "europe", id: listing.master_id }),
      });
      const payload = await response.json() as { calculation?: RussiaPriceResult; error?: string };
      if (!response.ok || !payload.calculation) throw new Error(payload.error ?? "Не удалось обновить цену.");
      setLiveRussiaCalculation(payload.calculation);
    } catch (error) {
      setRussiaRefreshError(error instanceof Error ? error.message : "Не удалось обновить цену.");
    } finally {
      setRussiaRefreshing(false);
    }
  }

  async function submitLead(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (destination === "ru" ? (!isVan && !activeRussiaCalculation) : (!isVan && !calculation)) return;
    const data = new FormData(event.currentTarget);
    setLeadSending(true);
    setLeadError("");
    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"), phone: data.get("phone"), message: data.get("message"), source: "vehicle",
          vehicleSnapshot: {
            source: "Mobile.de", masterId: listing.master_id, sourceId: listing.source_id, title,
            firstRegistration, mileageKm: listing.mileage_km, sourceUrl: source,
          },
          calculationSnapshot: isVan ? { type: "manager_consultation", transportClass: "VAN", sourcePriceEur: amount, priceBasis: listing.price?.basis, destination, displayPrice: formattedTotal } : destination === "ru" ? { ...activeRussiaCalculation, destination: "RU", currency, displayTotal: formattedTotal } : { ...calculation, preferential, destination: "BY", currency: "BYN" },
          pageUrl: window.location.href,
        }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Не удалось отправить заявку");
      setLeadSent(true);
    } catch (error) {
      setLeadError(error instanceof Error ? error.message : "Попробуйте ещё раз");
    } finally {
      setLeadSending(false);
    }
  }

  return <>
    <aside className="dossier-price" aria-label={isVan ? "Цена автомобиля в Европе" : "Предварительная стоимость автомобиля"}>
      <div className="dossier-source"><span><ShieldCheck size={14} />Источник Mobile.de</span><a href={source} target="_blank" rel="noreferrer">Оригинал <ExternalLink size={12} /></a></div>
      <div className="dossier-badges"><span>{isVan ? "Цена по объявлению" : `Расчёт для ${destination === "ru" ? "России" : "Беларуси"}`}</span><span>{destination === "ru" ? (rubRates || hasTurnkeyTotal ? currency === "BYN" ? "RUB" : currency : "EUR") : isVan ? "EUR" : "Минск"}</span></div>
      <div className="dossier-total">
        <span>{hasTurnkeyTotal ? "Цена под ключ" : "Цена в Европе"}</span>
        <CatalogPrice price={formattedTotal || "—"} info={hasTurnkeyTotal ? "Расчёт предварительный. Итоговую стоимость уточнит менеджер." : "Цена указана в Mobile.de. Стоимость под ключ уточнит менеджер."} />
        <small>{!hasTurnkeyTotal ? "Цена по объявлению Mobile.de" : destination === "ru" ? "с доставкой и оформлением в России" : "с доставкой и оформлением в Беларуси"}</small>
      </div>
      {destination === "by" && !isVan && <div className="dossier-preferential-block">
        <label className="dossier-preferential"><input type="checkbox" checked={preferential} disabled={!calculation} onChange={(event) => setPreferential(event.target.checked)} /><span>Льготная растаможка 50% <b className={preferential ? "" : "is-off"}>{preferential ? "Включена" : "Выключена"}</b></span></label>
      </div>}
      {isVan ? null : destination === "ru"
        ? activeRussiaCalculation
          ? <RussiaPriceBreakdown calculation={activeRussiaCalculation} isRefreshing={isRussiaRefreshing} refreshError={russiaRefreshError} onRefresh={() => void refreshRussiaPrice()} />
          : <details className="dossier-calculation" open><summary><Calculator size={15} />Расчёт цены <span>⌄</span></summary><div><p><span>Цена появится после обновления расчёта</span></p><button className="dossier-price-refresh" type="button" onClick={() => void refreshRussiaPrice()} disabled={isRussiaRefreshing}>{isRussiaRefreshing ? "Обновляем цену…" : "Обновить цену"}</button>{russiaRefreshError ? <p className="dossier-price-refresh-error" role="alert">{russiaRefreshError}</p> : null}</div></details>
        : <details className="dossier-calculation">
        <summary><Calculator size={15} />Расчёт цены <span>⌄</span></summary>
        {calculation ? <div>
          <p><span>{calculation.priceBasis === "unknown" ? "Цена по объявлению" : `Цена автомобиля (${calculation.priceBasis === "brutto" ? "Brutto" : "Netto"})`}</span><b>{money(calculation.sourcePriceEur, "EUR")}</b></p>
          <p><span>Услуги компании в ЕС</span><b>{money(calculation.ecServiceEur, "EUR")}</b></p>
          <p><span>Перевод</span><b>{money(calculation.translationEur, "EUR")}</b></p>
          <p><span>Доставка до Минска <InfoTooltip label="О стоимости доставки">Это средняя сумма доставки. Для более точного расчёта обратитесь к менеджеру.</InfoTooltip></span><b>{money(calculation.deliveryMinskEur, "EUR")}</b></p>
          <p><span>Услуга компании</span><b>{money(calculation.companyServiceEur, "EUR")}</b></p>
          <p><span>Таможенный платёж</span><b>{money(calculation.customsDutyEur, "EUR")}</b></p>
          <p><span>Утилизационный сбор</span><b>{money(calculation.recyclingFeeByn, "BYN")}</b></p>
          <p className="dossier-calculation-total"><span>Итого до Минска <InfoTooltip label="О предварительном расчёте">Расчёт предварительный. Итоговую стоимость уточнит менеджер.</InfoTooltip></span><b>{formattedTotal}</b></p>
        </div> : <div><p><span>{exchangeRates ? "Недостаточно данных для расчёта" : "Расчёт временно недоступен"}</span></p></div>}
      </details>}
      <button className="dossier-lead" type="button" disabled={!isVan && (destination === "ru" ? !activeRussiaCalculation : !calculation)} onClick={() => { setLeadOpen(true); setLeadSent(false); setLeadError(""); }}>{isVan ? "Запросить расчёт" : "Оставить заявку"} <ArrowRight size={17} /></button>
    </aside>

    {leadOpen && <div className="consult-modal-backdrop" onMouseDown={() => setLeadOpen(false)}><div className="consult-modal vehicle-lead-modal" role="dialog" aria-modal="true" aria-label="Заявка на автомобиль из Европы" onMouseDown={(event) => event.stopPropagation()}>
      <button className="consult-close" type="button" onClick={() => setLeadOpen(false)} aria-label="Закрыть">×</button>
      {leadSent ? <div className="lead-success"><Check /><b>Заявка принята</b><span>Менеджер свяжется с вами по этому автомобилю.</span></div> : <>
        <header className="vehicle-lead-heading"><p className="premium-kicker"><span />Заявка на автомобиль</p><h2>{title}</h2><p>Mobile.de · первая регистрация {firstRegistration || "не указана"}</p><strong>{formattedTotal} <small>{isVan ? "цена в Европе; расчёт при консультации" : "предварительно под ключ"}</small></strong></header>
        <form className="vehicle-lead-form" onSubmit={submitLead}>
          <div className="vehicle-lead-grid"><label><span>Ваше имя</span><input name="name" placeholder="Например, Евгений" required /></label><label><span>Телефон</span><input name="phone" placeholder="+375 (__) ___-__-__" inputMode="tel" required /></label></div>
          <label><span>Комментарий <i>необязательно</i></span><textarea name="message" placeholder="Ваш вопрос по автомобилю" rows={3} /></label>
          <footer><small>Отправляя заявку, вы соглашаетесь с обработкой персональных данных.</small><button type="submit" disabled={leadSending}>{leadSending ? "Отправляем…" : "Оставить заявку"} <ArrowRight /></button></footer>
          {leadError && <p className="vehicle-lead-error" role="alert">{leadError}</p>}
        </form>
      </>}
    </div></div>}
  </>;
}
