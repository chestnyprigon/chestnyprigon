"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, BadgeCheck, Calculator, CarFront, Check, ChevronDown, ExternalLink, FileSearch, KeyRound, ShieldCheck, X } from "lucide-react";
import type { CatalogCar, InspectionSummary, VehicleOption } from "@/data/cars";
import { calculateBelarusPrice } from "@/lib/pricing/emavto-profile";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("ru-RU");

function date(value: string | null) {
  if (!value) return "Не указано";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value.slice(0, 10) : new Intl.DateTimeFormat("ru-RU", { month: "2-digit", year: "numeric" }).format(parsed);
}

function krw(value: number) { return `${number.format(value)} ₩`; }

function groupChoicePackages(options: VehicleOption[]) {
  const groups = [
    { name: "Экстерьер и интерьер", match: /крыша|диски|прицеп|ключ|подножк|аксессуар/i },
    { name: "Безопасность", match: /круиз|камер|ассистент|проекц/i },
    { name: "Сиденья", match: /сиден|кресл|nappa/i },
  ].map((group) => ({ ...group, options: options.filter((item) => group.match.test(item.name)) }));
  const used = new Set(groups.flatMap((group) => group.options));
  return [...groups, { name: "Комфорт и мультимедиа", match: /.*/, options: options.filter((item) => !used.has(item)) }].filter((group) => group.options.length);
}

const equipmentCatalog = [
  { name: "Экстерьер и интерьер", items: [["010", "Люк"], ["075", "LED-фары"], ["029", "Ксеноновые фары"], ["059", "Электропривод багажника"], ["080", "Доводчики дверей"], ["024", "Электроскладывание зеркал"], ["017", "Легкосплавные диски"], ["062", "Рейлинги на крыше"]] },
  { name: "Комфорт и управление", items: [["082", "Подогрев руля"], ["083", "Электрорегулировка руля"], ["084", "Подрулевые переключатели"], ["031", "Кнопки управления на руле"], ["030", "Зеркало с автозатемнением"], ["074", "Система Hi-Pass"], ["006", "Центральный замок"], ["008", "Усилитель рулевого управления"], ["007", "Электростеклоподъёмники"]] },
  { name: "Безопасность", items: [["002", "Подушки безопасности"], ["026", "Подушка водителя"], ["027", "Подушка пассажира"], ["020", "Боковые подушки"], ["056", "Шторки безопасности"], ["001", "Антиблокировочная система ABS"], ["019", "Противобуксовочная система TCS"]] },
] as const;

function InspectionEvidence({ images, hasAccident }: { images: InspectionSummary["inspectionImages"]; hasAccident: boolean }) {
  if (!images.length) return <div className="dossier-inspection-empty"><FileSearch size={24} /><div><strong>Изображения осмотра отсутствуют</strong><p>Encar не предоставил графические материалы по этому автомобилю.</p></div></div>;
  return <div className="dossier-inspection-evidence">{images.map((image) => <figure key={image.url}><div><Image src={image.url} alt={`${image.title} — официальный осмотр Encar`} fill sizes="(max-width: 700px) 100vw, 380px" /></div><figcaption><span>{image.title}</span><small>Официальное изображение осмотра Encar</small></figcaption></figure>)}<p className={hasAccident ? "is-alert" : ""}><Check size={13} />{hasAccident ? "В истории есть отметки — требуется ручная проверка" : "В отчёте Encar критических отметок кузова нет"}</p></div>;
}

type BodyMark = { code: "X" | "W" | "C" | "A" | "U" | "T"; label: string; x: number; y: number };

const bodyPartPositions: Record<string, { label: string; x: number; y: number }> = {
  P011: { label: "Передний бампер", x: 50, y: 7 }, P012: { label: "Задний бампер", x: 50, y: 93 },
  P021: { label: "Переднее левое крыло", x: 12, y: 19 }, P022: { label: "Переднее правое крыло", x: 88, y: 19 },
  P031: { label: "Передняя левая дверь", x: 13, y: 43 }, P032: { label: "Передняя правая дверь", x: 84, y: 43 },
  P033: { label: "Задняя левая дверь", x: 13, y: 64 }, P034: { label: "Задняя правая дверь", x: 84, y: 64 },
  P041: { label: "Крышка багажника", x: 50, y: 82 }, P042: { label: "Капот", x: 50, y: 36 },
  P051: { label: "Левый порог", x: 20, y: 72 }, P052: { label: "Правый порог", x: 78, y: 72 }, P061: { label: "Крыша", x: 50, y: 50 },
};

const bodyLegend: Array<[BodyMark["code"], string]> = [["X", "замена"], ["W", "ремонт"], ["C", "коррозия"], ["A", "царапина"], ["U", "неровность"], ["T", "повреждение"]];

function bodyMarkCode(code: string | null, title: string) : BodyMark["code"] {
  if (code && ["X", "W", "C", "A", "U", "T"].includes(code)) return code as BodyMark["code"];
  if (/교환|교체|замен/i.test(title)) return "X";
  if (/판금|용접|ремонт/i.test(title)) return "W";
  if (/부식|корроз/i.test(title)) return "C";
  if (/스크래치|царап/i.test(title)) return "A";
  if (/굴곡|неров/i.test(title)) return "U";
  return "T";
}

function BodyConditionMap({ findings }: { findings: InspectionSummary["bodyFindings"] }) {
  const marks = findings.flatMap((finding) => {
    const part = finding.code ? bodyPartPositions[finding.code] : null;
    if (!part) return [];
    const statuses = finding.statuses.length ? finding.statuses : [{ code: null, title: "Повреждение" }];
    return statuses.map((status) => ({ code: bodyMarkCode(status.code, status.title), label: `${part.label}: ${status.title}`, x: part.x, y: part.y }));
  });
  return <div className="dossier-body-map"><div className="dossier-body-canvases"><div className="dossier-body-canvas"><Image src="/assets/body-condition-top.png" alt="Схема кузова автомобиля" fill sizes="(max-width: 700px) 100vw, 420px" />{marks.map((mark, index) => <span className={`dossier-body-mark is-${mark.code}`} style={{ left: `${mark.x}%`, top: `${mark.y}%` }} title={mark.label} key={`${mark.label}-${index}`}>{mark.code}</span>)}</div><div className="dossier-body-canvas"><Image src="/assets/body-condition-bottom.png" alt="Схема днища автомобиля" fill sizes="(max-width: 700px) 100vw, 420px" /></div></div><div className="dossier-body-legend">{bodyLegend.map(([code, label]) => <span key={code}><b className={`is-${code}`}>{code}</b>{label}</span>)}</div><p className={marks.length ? "is-alert" : ""}>{marks.length ? `${marks.length} отметок кузова по отчёту Encar` : "По отчёту Encar отметок по кузовным элементам нет"}</p></div>;
}

export function VehicleDossier({ car }: { car: CatalogCar }) {
  const [photo, setPhoto] = useState(0);
  const [preferential, setPreferential] = useState(true);
  const calculation = useMemo(() => calculateBelarusPrice({ priceKrw: car.sourcePriceKrw, engineCc: car.engineCc, firstRegistrationDate: car.registrationDate, fuelType: car.sourceFuel, preferential }), [car, preferential]);
  const choiceGroups = useMemo(() => groupChoicePackages(car.options), [car.options]);
  const standardCodes = useMemo(() => new Set(car.inspection?.standardOptionCodes ?? []), [car.inspection?.standardOptionCodes]);
  const accident = Boolean(car.accidents?.accidentCount || car.inspection?.reportedAccident);

  return <main className="dossier-page">
    <header className="dossier-header"><Link href="/catalog"><ArrowLeft size={16} />Вернуться в каталог</Link><span>ЧЕСТНЫЙ <em>ПРИГОН</em> · Корея</span><Link href="/#contacts">Получить консультацию <ArrowRight size={15} /></Link></header>
    <section className="dossier-layout">
      <div className="dossier-content">
        <section className="dossier-gallery"><div className="dossier-main-photo"><Image src={car.images[photo] ?? car.images[0]} alt={`${car.brand} ${car.model}`} fill priority sizes="(max-width: 1024px) 100vw, 760px" /><span><BadgeCheck size={14} />Проверено</span><small>{photo + 1} / {car.images.length}</small></div><div className="dossier-thumbs">{car.images.slice(0, 6).map((image, index) => <button key={image} type="button" className={index === photo ? "is-active" : ""} onClick={() => setPhoto(index)}><Image src={image} alt={`${car.brand} ${car.model}, фото ${index + 1}`} fill sizes="110px" />{index === 5 && car.images.length > 6 ? <b>Ещё {car.images.length - 6}</b> : null}</button>)}</div></section>

        <section className="dossier-card"><h2><CarFront />Общие данные</h2><div className="dossier-spec-cards"><div><span>Год регистрации</span><b>{date(car.registrationDate)}</b></div><div><span>Пробег</span><b>{number.format(car.mileage)} км</b></div><div><span>Двигатель</span><b>{car.engine}</b></div><div><span>Топливо</span><b>{car.fuel}</b></div></div><div className="dossier-lines"><div><span>Коробка передач</span><b>{car.transmission}</b></div><div><span>Привод</span><b>{car.drive}</b></div><div><span>Тип кузова</span><b>{car.bodyType}</b></div><div><span>Цвет</span><b>{car.color}</b></div></div></section>

        <section className="dossier-card"><h2><ShieldCheck />История и состояние кузова</h2><BodyConditionMap findings={car.inspection?.bodyFindings ?? []} /><InspectionEvidence images={car.inspection?.inspectionImages ?? []} hasAccident={accident} /><div className="dossier-history-lines"><div><span>Техосмотр Encar</span><b>{car.inspection?.state ?? "Нет данных"}</b></div><div><span>Страховые случаи</span><b>{car.accidents?.accidentCount ?? "Нет данных"}</b></div><div><span>Страховые выплаты</span><b>{car.accidents ? krw(car.accidents.ownAccidentCostKrw + car.accidents.otherAccidentCostKrw) : "Нет данных"}</b></div><div><span>Смена владельцев</span><b>{car.accidents?.ownerChangeCount ?? "Нет данных"}</b></div><div><span>Тотальная гибель / угон</span><b>{car.accidents ? `${car.accidents.totalLossCount} / ${car.accidents.theftCount}` : "Нет данных"}</b></div><div><span>Затопление</span><b>{car.inspection?.waterlog ? "Есть отметка" : "Не заявлено"}</b></div><div><span>Пробег по осмотру</span><b>{car.inspection?.inspectionMileage ? `${number.format(car.inspection.inspectionMileage)} км` : "Нет данных"}</b></div><div><span>VIN</span><b>{car.vinMasked ?? "Скрыт источником"}</b></div></div>{car.inspection?.checks.length ? <details className="dossier-inspection"><summary>Результаты технического осмотра: {car.inspection.checks.length} пунктов <ChevronDown size={17} /></summary><div>{car.inspection.checks.map((check, index) => <p key={`${check.title}-${index}`}><span>{check.title}</span><b>{check.status}</b></p>)}</div></details> : null}</section>

        <section className="dossier-card"><h2><KeyRound />Комплектация</h2><div className="dossier-options">{equipmentCatalog.map((group, index) => { const installed = group.items.filter(([code]) => standardCodes.has(code)).length; return <details key={group.name} open={index === 0}><summary><span><b>{group.name}</b><small>{installed} установлено · не установлено: {group.items.length - installed}</small></span><ChevronDown size={18} /></summary><div>{group.items.map(([code, name]) => { const isInstalled = standardCodes.has(code); return <article className={isInstalled ? "" : "is-missing"} key={`${group.name}-${code}`}><span className="equipment-mark">{isInstalled ? <Check size={13} /> : <X size={13} />}</span><span>{name}<small>{isInstalled ? "Установлено" : "Не установлено"}</small></span></article>; })}</div></details>; })}</div>{choiceGroups.length ? <details className="dossier-choice-packages"><summary>Дополнительные заводские пакеты Encar <ChevronDown size={17} /></summary><div>{choiceGroups.flatMap((group) => group.options).map((option) => <p key={`${option.name}-${option.priceKrw ?? ""}`}><span>{option.name}</span>{option.priceKrw ? <b>{krw(option.priceKrw)}</b> : null}</p>)}</div><small>Это прайс доступных пакетов для модели, а не подтверждение их установки на данном автомобиле.</small></details> : null}</section>
      </div>

      <aside className="dossier-price"><div className="dossier-source"><span><BadgeCheck size={15} />Источник Encar</span><a href={car.sourceUrl} target="_blank" rel="noreferrer">Оригинал <ExternalLink size={12} /></a></div><h1>{car.brand} {car.model}</h1><h3>{car.trim}</h3><p>{car.year} год · {number.format(car.mileage)} км · {car.engineCc ? `${number.format(car.engineCc)} см³` : "Электро"}</p><div className="dossier-badges"><span>Расчёт для РБ</span><span>Минск</span></div><div className="dossier-total"><span>Предварительная цена под ключ</span><strong>{money.format(calculation.totalUsd)}</strong><small>с доставкой и оформлением в Беларуси</small></div><div className="dossier-price-bar"><i /><i /><i /></div><div className="dossier-price-legend"><span>Стоимость авто</span><span>Расходы в Корее</span><span>Логистика и услуги</span></div><div className="dossier-notice">Итог зависит от курса, даты оформления и параметров автомобиля.</div><div className="dossier-lines dossier-price-lines"><div><span>Цена в Корее</span><b>{krw(car.sourcePriceKrw)}</b></div><div><span>Топливо</span><b>{car.fuel}</b></div><div><span>КПП</span><b>{car.transmission}</b></div><div><span>Привод</span><b>{car.drive}</b></div><div><span>Цвет</span><b>{car.color}</b></div></div><label className="dossier-preferential"><input type="checkbox" checked={preferential} disabled={car.fuel === "Электро"} onChange={(event) => setPreferential(event.target.checked)} />Льготная растаможка</label><details className="dossier-calculation"><summary><Calculator size={15} />Показать расчёт цены <ChevronDown size={16} /></summary><div>{[["Авто и расходы в Корее", calculation.koreaAndExportUsd], ["Доставка до Минска", calculation.deliveryUsd], ["Транзитная декларация", calculation.transitUsd], ["Растаможка", calculation.customsDutyUsd], ["СВХ, платежи и утиль", calculation.customsServicesUsd], ["Подбор и сопровождение", calculation.companyServicesUsd]].map(([label, value]) => <p key={String(label)}><span>{label}</span><b>{money.format(Number(value))}</b></p>)}</div></details><Link className="dossier-lead" href="/#contacts">Оставить заявку <ArrowRight size={17} /></Link></aside>
    </section>
  </main>;
}
