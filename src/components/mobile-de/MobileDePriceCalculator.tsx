"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { calculateEuropeBelarusPrice } from "@/lib/pricing/europe-belarus";
import type { ExchangeRates } from "@/lib/pricing/chestny-prigon-profile";
import type { MobileDeListing } from "@/lib/mobile-de/types";
import styles from "./MobileDePriceCalculator.module.css";

const money = (amount: number, currency: "EUR" | "BYN") => new Intl.NumberFormat("ru-RU", {
  style: "currency", currency, maximumFractionDigits: 2,
}).format(amount);

export function MobileDePriceCalculator({ listing, exchangeRates }: {
  listing: Pick<MobileDeListing, "net_price" | "first_registration" | "engine_cc">;
  exchangeRates: ExchangeRates | null;
}) {
  const [preferential, setPreferential] = useState(true);
  const amount = listing.net_price?.amount;
  const firstRegistration = listing.first_registration?.value;
  const calculation = useMemo(() => {
    if (!exchangeRates || exchangeRates.source !== "nbrb" || amount == null || listing.net_price?.basis !== "netto" || listing.net_price?.status !== "source_reported" || listing.net_price?.source_path !== "cars.price_net" || !firstRegistration || !listing.engine_cc) return null;
    return calculateEuropeBelarusPrice({
      netPriceEur: amount,
      firstRegistration,
      engineCc: listing.engine_cc,
      preferential,
      exchangeRates,
    });
  }, [amount, exchangeRates, listing.engine_cc, listing.net_price?.basis, listing.net_price?.status, listing.net_price?.source_path, preferential, firstRegistration]);

  return <section className={styles.calculator} aria-labelledby="europe-price-heading">
    <div className={styles.heading}>
      <div><h2 id="europe-price-heading">Предварительный расчёт под ключ</h2></div>
      {calculation && <strong>{money(calculation.totalByn, "BYN")}</strong>}
    </div>

    {!exchangeRates ? <p className={styles.unavailable}>Расчёт временно недоступен.</p> : !calculation ?
      <p className={styles.unavailable}>Недостаточно данных для расчёта.</p> : <>
        <label className={styles.toggle}>
          <input type="checkbox" checked={preferential} onChange={(event) => setPreferential(event.target.checked)} />
          <span><strong>Льготная растаможка 50%</strong></span>
        </label>
        <dl className={styles.rows}>
          <div><dt>Цена Netto</dt><dd>{money(calculation.netPriceEur, "EUR")}</dd></div>
          <div><dt>Услуги компании в ЕС</dt><dd>{money(calculation.ecServiceEur, "EUR")}</dd></div>
          <div><dt>Перевод</dt><dd>{money(calculation.translationEur, "EUR")}</dd></div>
          <div>
            <dt className={styles.deliveryLabel}>Доставка до Минска <span className={styles.infoIcon} aria-label="Средняя стоимость доставки" title="Средняя стоимость доставки. Для точного расчёта обратитесь к менеджеру.">i</span><small>Средняя стоимость; точную уточнит менеджер</small></dt>
            <dd>{money(calculation.deliveryMinskEur, "EUR")}</dd>
          </div>
          <div><dt>Услуга компании</dt><dd>{money(calculation.companyServiceEur, "EUR")}</dd></div>
          <div><dt>Таможенный платёж для физлица{preferential ? " · с льготой 50%" : ""}</dt><dd>{money(calculation.customsDutyEur, "EUR")}</dd></div>
          <div><dt>Утилизационный сбор</dt><dd>{money(calculation.recyclingFeeByn, "BYN")}</dd></div>
        </dl>
        <div className={styles.total}>
          <span>Предварительная стоимость до Минска</span>
          <strong>{money(calculation.totalByn, "BYN")}</strong>
        </div>
        <p className={styles.totalNote}><span className={styles.infoIcon} aria-hidden="true">i</span>Стоимость предварительная. Для точного расчёта обратитесь к менеджеру.</p>
      </>}

    <Link className={styles.cta} href="/#contacts">Оставить заявку <span>→</span></Link>
  </section>;
}
