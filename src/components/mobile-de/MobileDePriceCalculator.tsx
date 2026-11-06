"use client";

import { type FormEvent, useMemo, useState } from "react";
import { ArrowRight, Calculator, Check, ExternalLink, ShieldCheck } from "lucide-react";
import { calculateEuropeBelarusPrice } from "@/lib/pricing/europe-belarus";
import { formatEuropeTurnkeyPrice } from "@/lib/pricing/europe-display";
import type { ExchangeRates } from "@/lib/pricing/chestny-prigon-profile";
import type { MobileDeListing } from "@/lib/mobile-de/types";
import { InfoTooltip } from "./InfoTooltip";

const money = (amount: number, currency: "EUR" | "BYN") => new Intl.NumberFormat("ru-RU", {
  style: "currency", currency, maximumFractionDigits: 2,
}).format(amount);

function sourceUrl(sourceId: string) {
  const url = new URL("https://suchen.mobile.de/fahrzeuge/details.html");
  url.searchParams.set("id", sourceId);
  return url.toString();
}

export function MobileDePriceCalculator({ listing, exchangeRates }: {
  listing: MobileDeListing;
  exchangeRates: ExchangeRates | null;
}) {
  const [preferential, setPreferential] = useState(true);
  const [leadOpen, setLeadOpen] = useState(false);
  const [leadSent, setLeadSent] = useState(false);
  const [leadSending, setLeadSending] = useState(false);
  const [leadError, setLeadError] = useState("");
  const amount = listing.net_price?.amount;
  const firstRegistration = listing.first_registration?.value;
  const calculation = useMemo(() => {
    if (!exchangeRates || exchangeRates.source !== "nbrb" || amount == null || listing.net_price?.basis !== "netto" || listing.net_price?.status !== "source_reported" || listing.net_price?.source_path !== "cars.price_net" || !firstRegistration || !listing.engine_cc) return null;
    return calculateEuropeBelarusPrice({ netPriceEur: amount, firstRegistration, engineCc: listing.engine_cc, preferential, exchangeRates });
  }, [amount, exchangeRates, listing.engine_cc, listing.net_price?.basis, listing.net_price?.status, listing.net_price?.source_path, preferential, firstRegistration]);
  const title = listing.title || [listing.make, listing.model].filter(Boolean).join(" ") || "Автомобиль из Европы";
  const source = sourceUrl(listing.source_id);
  const formattedTotal = calculation && exchangeRates ? formatEuropeTurnkeyPrice(calculation.totalByn, exchangeRates.eurByn) : "";

  async function submitLead(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!calculation) return;
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
          calculationSnapshot: { ...calculation, preferential },
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
    <aside className="dossier-price" aria-label="Предварительная стоимость автомобиля">
      <div className="dossier-source"><span><ShieldCheck size={14} />Источник Mobile.de</span><a href={source} target="_blank" rel="noreferrer">Оригинал <ExternalLink size={12} /></a></div>
      <div className="dossier-badges"><span>Расчёт для РБ</span><span>Минск</span></div>
      <div className="dossier-total">
        <span>Цена под ключ <InfoTooltip label="О предварительной стоимости">Стоимость предварительная. Для точного расчёта обратитесь к менеджеру.</InfoTooltip></span>
        <strong>{formattedTotal || (calculation ? money(calculation.totalByn, "BYN") : "—")}</strong>
        <small>с доставкой и оформлением в Беларуси</small>
      </div>
      <div className="dossier-preferential-block">
        <label className="dossier-preferential"><input type="checkbox" checked={preferential} disabled={!calculation} onChange={(event) => setPreferential(event.target.checked)} /><span>Льготная растаможка 50% <b className={preferential ? "" : "is-off"}>{preferential ? "Включена" : "Выключена"}</b></span></label>
      </div>
      <details className="dossier-calculation">
        <summary><Calculator size={15} />Расчёт цены <span>⌄</span></summary>
        {calculation ? <div>
          <p><span>Цена Netto</span><b>{money(calculation.netPriceEur, "EUR")}</b></p>
          <p><span>Услуги компании в ЕС</span><b>{money(calculation.ecServiceEur, "EUR")}</b></p>
          <p><span>Перевод</span><b>{money(calculation.translationEur, "EUR")}</b></p>
          <p><span>Доставка до Минска <InfoTooltip label="О стоимости доставки">Это средняя сумма доставки. Для более точного расчёта обратитесь к менеджеру.</InfoTooltip></span><b>{money(calculation.deliveryMinskEur, "EUR")}</b></p>
          <p><span>Услуга компании</span><b>{money(calculation.companyServiceEur, "EUR")}</b></p>
          <p><span>Таможенный платёж для физлица{preferential ? " · льготный режим" : ""}</span><b>{money(calculation.customsDutyEur, "EUR")}</b></p>
          <p><span>Утилизационный сбор</span><b>{money(calculation.recyclingFeeByn, "BYN")}</b></p>
          <p className="dossier-calculation-total"><span>Итого до Минска <InfoTooltip label="О предварительной стоимости">Стоимость предварительная. Для точного расчёта обратитесь к менеджеру.</InfoTooltip></span><b>{formattedTotal}</b></p>
        </div> : <div><p><span>{exchangeRates ? "Недостаточно данных для расчёта" : "Расчёт временно недоступен"}</span></p></div>}
      </details>
      <button className="dossier-lead" type="button" disabled={!calculation} onClick={() => { setLeadOpen(true); setLeadSent(false); setLeadError(""); }}>Оставить заявку <ArrowRight size={17} /></button>
    </aside>

    {leadOpen && <div className="consult-modal-backdrop" onMouseDown={() => setLeadOpen(false)}><div className="consult-modal vehicle-lead-modal" role="dialog" aria-modal="true" aria-label="Заявка на автомобиль из Европы" onMouseDown={(event) => event.stopPropagation()}>
      <button className="consult-close" type="button" onClick={() => setLeadOpen(false)} aria-label="Закрыть">×</button>
      {leadSent ? <div className="lead-success"><Check /><b>Заявка принята</b><span>Менеджер свяжется с вами по этому автомобилю.</span></div> : <>
        <header className="vehicle-lead-heading"><p className="premium-kicker"><span />Заявка на автомобиль</p><h2>{title}</h2><p>Mobile.de · первая регистрация {firstRegistration || "не указана"}</p><strong>{formattedTotal} <small>предварительно под ключ</small></strong></header>
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
