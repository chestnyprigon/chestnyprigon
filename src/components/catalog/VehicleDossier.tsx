"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, BadgeCheck, Calculator, CarFront, Check, ChevronDown, CircleAlert, ExternalLink, KeyRound, ShieldCheck } from "lucide-react";
import type { CatalogCar, VehicleOption } from "@/data/cars";
import { calculateBelarusPrice } from "@/lib/pricing/emavto-profile";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("ru-RU");

function date(value: string | null) {
  if (!value) return "Не указано";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value.slice(0, 10) : new Intl.DateTimeFormat("ru-RU", { month: "2-digit", year: "numeric" }).format(parsed);
}

function krw(value: number) { return `${number.format(value)} ₩`; }

function groupOptions(options: VehicleOption[]) {
  const groups = [
    { name: "Экстерьер и интерьер", match: /крыша|диски|прицеп|ключ|подножк|аксессуар/i },
    { name: "Безопасность", match: /круиз|камер|ассистент|проекц/i },
    { name: "Сиденья", match: /сиден|кресл|nappa/i },
  ].map((group) => ({ ...group, options: options.filter((item) => group.match.test(item.name)) }));
  const used = new Set(groups.flatMap((group) => group.options));
  return [...groups, { name: "Комфорт и мультимедиа", match: /.*/, options: options.filter((item) => !used.has(item)) }].filter((group) => group.options.length);
}

function BodyScheme({ hasAccident }: { hasAccident: boolean }) {
  return <div className="dossier-body-scheme" aria-label="Схема состояния кузова">
    <svg viewBox="0 0 600 210" role="img" aria-hidden="true"><g fill="none" stroke="currentColor" strokeWidth="2"><path d="M63 104h56l20-40h320l22 40h56v37h-56l-22 34H159l-20-34H63z" /><path d="M205 64l18 77m154-77-18 77M159 141h300M244 64v-28h112v28M244 141v31h112v-31" /><circle cx="160" cy="142" r="31" /><circle cx="440" cy="142" r="31" /><path d="M63 104v37m474-37v37M119 104h50m262 0h50" /></g>{hasAccident ? <circle cx="300" cy="104" r="13" fill="#e43b34" /> : <path d="M286 105l10 10 20-23" fill="none" stroke="#78d6af" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />}</svg>
    <div><span className={hasAccident ? "is-alert" : ""}>{hasAccident ? <CircleAlert size={13} /> : <Check size={13} />}{hasAccident ? "Требуется ручная проверка" : "По отчёту Encar критических отметок нет"}</span><small>Схема носит информационный характер. Осмотр кузова подтверждаем перед выкупом.</small></div>
  </div>;
}

export function VehicleDossier({ car }: { car: CatalogCar }) {
  const [photo, setPhoto] = useState(0);
  const [preferential, setPreferential] = useState(true);
  const calculation = useMemo(() => calculateBelarusPrice({ priceKrw: car.sourcePriceKrw, engineCc: car.engineCc, firstRegistrationDate: car.registrationDate, fuelType: car.sourceFuel, preferential }), [car, preferential]);
  const optionGroups = useMemo(() => groupOptions(car.options), [car.options]);
  const accident = Boolean(car.accidents?.accidentCount || car.inspection?.reportedAccident);

  return <main className="dossier-page">
    <header className="dossier-header"><Link href="/catalog"><ArrowLeft size={16} />Вернуться в каталог</Link><span>ЧЕСТНЫЙ <em>ПРИГОН</em> · Корея</span><Link href="/#contacts">Получить консультацию <ArrowRight size={15} /></Link></header>
    <section className="dossier-layout">
      <div className="dossier-content">
        <section className="dossier-gallery"><div className="dossier-main-photo"><Image src={car.images[photo] ?? car.images[0]} alt={`${car.brand} ${car.model}`} fill priority sizes="(max-width: 1024px) 100vw, 760px" /><span><BadgeCheck size={14} />Проверено</span><small>{photo + 1} / {car.images.length}</small></div><div className="dossier-thumbs">{car.images.slice(0, 6).map((image, index) => <button key={image} type="button" className={index === photo ? "is-active" : ""} onClick={() => setPhoto(index)}><Image src={image} alt={`${car.brand} ${car.model}, фото ${index + 1}`} fill sizes="110px" />{index === 5 && car.images.length > 6 ? <b>Ещё {car.images.length - 6}</b> : null}</button>)}</div></section>

        <section className="dossier-card"><h2><CarFront />Общие данные</h2><div className="dossier-spec-cards"><div><span>Год регистрации</span><b>{date(car.registrationDate)}</b></div><div><span>Пробег</span><b>{number.format(car.mileage)} км</b></div><div><span>Двигатель</span><b>{car.engine}</b></div><div><span>Топливо</span><b>{car.fuel}</b></div></div><div className="dossier-lines"><div><span>Коробка передач</span><b>{car.transmission}</b></div><div><span>Привод</span><b>{car.drive}</b></div><div><span>Тип кузова</span><b>{car.bodyType}</b></div><div><span>Цвет</span><b>{car.color}</b></div></div></section>

        <section className="dossier-card"><h2><ShieldCheck />История и состояние кузова</h2><BodyScheme hasAccident={accident} /><div className="dossier-history-lines"><div><span>Техосмотр Encar</span><b>{car.inspection?.state ?? "Нет данных"}</b></div><div><span>Страховые случаи</span><b>{car.accidents?.accidentCount ?? "Нет данных"}</b></div><div><span>Смена владельцев</span><b>{car.accidents?.ownerChangeCount ?? "Нет данных"}</b></div><div><span>Затопление</span><b>{car.inspection?.waterlog ? "Есть отметка" : "Не заявлено"}</b></div><div><span>Пробег по осмотру</span><b>{car.inspection?.inspectionMileage ? `${number.format(car.inspection.inspectionMileage)} км` : "Нет данных"}</b></div><div><span>VIN</span><b>{car.vinMasked ?? "Скрыт источником"}</b></div></div></section>

        {optionGroups.length ? <section className="dossier-card"><h2><KeyRound />Комплектация</h2><div className="dossier-options">{optionGroups.map((group, index) => <details key={group.name} open={index === 0}><summary><span><b>{group.name}</b><small>{group.options.length} установлено</small></span><ChevronDown size={18} /></summary><div>{group.options.map((option) => <article key={`${option.name}-${option.priceKrw ?? ""}`}><Check size={13} /><span>{option.name}<small>Установлено</small></span>{option.priceKrw ? <em>{krw(option.priceKrw)}</em> : null}</article>)}</div></details>)}</div></section> : null}
      </div>

      <aside className="dossier-price"><div className="dossier-source"><span><BadgeCheck size={15} />Источник Encar</span><a href={car.sourceUrl} target="_blank" rel="noreferrer">Оригинал <ExternalLink size={12} /></a></div><h1>{car.brand} {car.model}</h1><h3>{car.trim}</h3><p>{car.year} год · {number.format(car.mileage)} км · {car.engineCc ? `${number.format(car.engineCc)} см³` : "Электро"}</p><div className="dossier-badges"><span>Расчёт для РБ</span><span>Минск</span></div><div className="dossier-total"><span>Предварительная цена под ключ</span><strong>{money.format(calculation.totalUsd)}</strong><small>с доставкой и оформлением в Беларуси</small></div><div className="dossier-price-bar"><i /><i /><i /></div><div className="dossier-price-legend"><span>Стоимость авто</span><span>Расходы в Корее</span><span>Логистика и услуги</span></div><div className="dossier-notice">Итог зависит от курса, даты оформления и параметров автомобиля.</div><div className="dossier-lines dossier-price-lines"><div><span>Цена в Корее</span><b>{krw(car.sourcePriceKrw)}</b></div><div><span>Топливо</span><b>{car.fuel}</b></div><div><span>КПП</span><b>{car.transmission}</b></div><div><span>Привод</span><b>{car.drive}</b></div><div><span>Цвет</span><b>{car.color}</b></div></div><label className="dossier-preferential"><input type="checkbox" checked={preferential} disabled={car.fuel === "Электро"} onChange={(event) => setPreferential(event.target.checked)} />Льготная растаможка</label><details className="dossier-calculation"><summary><Calculator size={15} />Показать расчёт цены <ChevronDown size={16} /></summary><div>{[["Авто и расходы в Корее", calculation.koreaAndExportUsd], ["Доставка до Минска", calculation.deliveryUsd], ["Транзитная декларация", calculation.transitUsd], ["Растаможка", calculation.customsDutyUsd], ["СВХ, платежи и утиль", calculation.customsServicesUsd], ["Подбор и сопровождение", calculation.companyServicesUsd]].map(([label, value]) => <p key={String(label)}><span>{label}</span><b>{money.format(Number(value))}</b></p>)}</div></details><Link className="dossier-lead" href="/#contacts">Оставить заявку <ArrowRight size={17} /></Link></aside>
    </section>
  </main>;
}
