"use client";

import Image from "next/image";
import Link from "next/link";
import { type TouchEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Calculator, CarFront, Check, ChevronDown, ExternalLink, FileSearch, KeyRound, Maximize2, Menu, Minus, Plus, ShieldCheck, X } from "lucide-react";
import type { AccidentSummary, CatalogCar, InspectionSummary } from "@/data/cars";
import { calculateBelarusPrice, type BelarusPriceCalculation } from "@/lib/pricing/chestny-prigon-profile";
import type { PricingContext } from "@/lib/pricing/pricing-context";
import { formatUsdWithByn } from "@/lib/pricing/display";

const number = new Intl.NumberFormat("ru-RU");

function date(value: string | null) {
  if (!value) return "Не указано";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value.slice(0, 10) : new Intl.DateTimeFormat("ru-RU", { month: "2-digit", year: "numeric" }).format(parsed);
}

function krw(value: number) { return `${number.format(value)}\u00a0₩`; }
function eur(value: number) { return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value); }

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
type GalleryGroup = "Все фото" | "Кузов" | "Салон" | "Детали" | "Другие фото";
const galleryGroupOrder: GalleryGroup[] = ["Все фото", "Кузов", "Салон", "Детали", "Другие фото"];

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

function InsuranceBreakdown({ events }: { events: AccidentSummary["insuranceEvents"] }) {
  if (!events.length) return null;
  const total = events.reduce((sum, event) => sum + event.amountKrw, 0);
  return <details className="dossier-insurance"><summary><span>Детализация страховых выплат</span><b>{krw(total)}</b><ChevronDown size={17} /></summary><div>{events.map((event) => <article key={`${event.date}-${event.amountKrw}`}><header><div><b>{event.date}</b><span>{event.type}</span></div><strong>{krw(event.amountKrw)}</strong></header><p><span>Запчасти</span><b>{event.partsKrw ? krw(event.partsKrw) : "Нет данных"}</b></p><p><span>Окрас</span><b>{event.paintingKrw ? krw(event.paintingKrw) : "Нет данных"}</b></p><p><span>Работы</span><b>{event.laborKrw ? krw(event.laborKrw) : "Нет данных"}</b></p></article>)}</div></details>;
}

function ClientPriceTable({ calculation }: { calculation: BelarusPriceCalculation }) {
  const dollar = (value: number | null) => formatUsdWithByn(value, calculation.rates);
  const euro = (value: number | null) => value === null ? "Расчёт уточняется" : eur(value);
  return <details className="dossier-calculation">
    <summary><Calculator size={15} />Расчёт цены <ChevronDown size={16} /></summary>
    <div className="dossier-client-table">
      <p><span>Цена авто (KRW)</span><b>{krw(calculation.sourcePriceKrw)}</b></p>
      <p><span>Курс</span><b>₩{number.format(calculation.krwPerUsd)}</b></p>
      <p className="is-emphasis"><span>Стоимость в Корее</span><b>{dollar(calculation.sourcePriceUsd)}</b></p>
      <p><span>Доставка до Минска</span><b>{dollar(calculation.deliveryUsd)}</b></p>
      <p><span>Комиссия 2 %</span><b>{dollar(calculation.commissionUsd)}</b></p>
      <p className="is-emphasis"><span>Первый платёж</span><b>{dollar(calculation.firstPaymentUsd)}</b></p>
      <p><span>Услуги СВХ и декларант</span><b>{euro(calculation.svhDeclarantEur)}</b></p>
      <p><span>Таможенная пошлина</span><b>{euro(calculation.customsDutyEur)}</b></p>
      <p><span>Оформление и сопровождение</span><b>{euro(calculation.customsClearanceEur)}</b></p>
      <p><span>Утилизационный сбор</span><b>{euro(calculation.utilizationFeeEur)}</b></p>
      <p className="is-emphasis"><span>По прибытии в Минск</span><b>{euro(calculation.arrivalMinskEur)}</b></p>
      <p><span>Услуга (подбор/выкуп/доставка)</span><b>{dollar(calculation.companyServiceUsd)}</b></p>
      <p className="is-total"><span>ИТОГО в Минске:</span><b>{dollar(calculation.totalUsd)}</b></p>
      <small className="dossier-rate-note">Курсы валют обновляются по данным НБРБ на дату расчёта. Таможенные платежи зависят от параметров автомобиля; льготный режим применяется только после подтверждения права на него.</small>
    </div>
  </details>;
}

export function VehicleDossier({ car, pricingContext }: { car: CatalogCar; pricingContext: PricingContext }) {
  const [photo, setPhoto] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [photoGroup, setPhotoGroup] = useState<GalleryGroup>("Все фото");
  const [zoom, setZoom] = useState(1);
  const [preferential, setPreferential] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const thumbsRef = useRef<HTMLDivElement>(null);
  const photoSwipeStart = useRef<{ x: number; y: number } | null>(null);
  const suppressPhotoClick = useRef(false);
  const calculation = useMemo(() => calculateBelarusPrice({ priceKrw: car.sourcePriceKrw, engineCc: car.engineCc, firstRegistrationDate: car.registrationDate, fuelType: car.sourceFuel, preferential, profile: pricingContext.profile, exchangeRates: pricingContext.exchangeRates }), [car, preferential, pricingContext]);
  const standardCodes = useMemo(() => new Set(car.inspection?.standardOptionCodes ?? []), [car.inspection?.standardOptionCodes]);
  const accident = Boolean(car.accidents?.accidentCount || car.inspection?.reportedAccident);
  const historyBadge = car.accidents?.accidentCount
    ? { label: `Страховые случаи: ${car.accidents.accidentCount}`, tone: "is-alert" }
    : car.accidents?.available || car.inspection
      ? { label: "Без ДТП по отчёту Encar", tone: "is-clear" }
      : { label: "История Encar", tone: "is-neutral" };
  const imageGroups = useMemo(() => car.imageGroups.length ? car.imageGroups : car.images.map((url) => ({ url, group: "Другие фото" as const })), [car.imageGroups, car.images]);
  const availableGroups = useMemo(() => galleryGroupOrder.filter((group) => group === "Все фото" || imageGroups.some((image) => image.group === group)), [imageGroups]);
  const visiblePhotoIndexes = useMemo(() => imageGroups.flatMap((image, index) => photoGroup === "Все фото" || image.group === photoGroup ? [index] : []), [imageGroups, photoGroup]);
  const changePhoto = useCallback((offset: number) => {
    setPhoto((current) => {
      const currentPosition = Math.max(0, visiblePhotoIndexes.indexOf(current));
      return visiblePhotoIndexes[(currentPosition + offset + visiblePhotoIndexes.length) % visiblePhotoIndexes.length] ?? current;
    });
    setZoom(1);
  }, [visiblePhotoIndexes]);
  const chooseGroup = (group: GalleryGroup) => {
    setPhotoGroup(group);
    const first = imageGroups.findIndex((image) => group === "Все фото" || image.group === group);
    if (first >= 0) setPhoto(first);
    setZoom(1);
  };
  const scrollThumbnails = (direction: number) => thumbsRef.current?.scrollBy({ left: direction * 480, behavior: "smooth" });
  const openLightbox = (index = photo) => {
    setPhoto(index);
    setPhotoGroup("Все фото");
    setZoom(1);
    setLightboxOpen(true);
  };
  const beginPhotoSwipe = (event: TouchEvent<HTMLElement>) => {
    const touch = event.touches[0];
    photoSwipeStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const endPhotoSwipe = (event: TouchEvent<HTMLElement>) => {
    const started = photoSwipeStart.current;
    const touch = event.changedTouches[0];
    photoSwipeStart.current = null;
    if (!started || !touch) return;
    const horizontalDistance = touch.clientX - started.x;
    const verticalDistance = touch.clientY - started.y;
    if (Math.abs(horizontalDistance) < 42 || Math.abs(horizontalDistance) < Math.abs(verticalDistance) * 1.25) return;
    suppressPhotoClick.current = true;
    changePhoto(horizontalDistance < 0 ? 1 : -1);
    window.setTimeout(() => { suppressPhotoClick.current = false; }, 0);
  };

  useEffect(() => {
    if (!lightboxOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLightboxOpen(false);
      if (event.key === "ArrowLeft") changePhoto(-1);
      if (event.key === "ArrowRight") changePhoto(1);
      if (event.key === "+" || event.key === "=") setZoom((value) => Math.min(2.5, value + .25));
      if (event.key === "-") setZoom((value) => Math.max(1, value - .25));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [changePhoto, lightboxOpen]);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  return <main className="dossier-page">
    <header className="catalog-header">
      <Link className="premium-brand" href="/" aria-label="На главную"><span className="premium-brand-art"><Image className="premium-brand-mark" src="/assets/logo-header-dark.png" alt="Честный пригон" width={2172} height={724} priority /></span></Link>
      <nav className={menuOpen ? "catalog-nav is-open" : "catalog-nav"}>
        <Link href="/" onClick={() => setMenuOpen(false)}>Главная</Link>
        <Link className="is-active" href="/catalog" onClick={() => setMenuOpen(false)}>Каталог</Link>
        <Link href="/#services" onClick={() => setMenuOpen(false)}>Услуги</Link>
        <Link href="/#reviews" onClick={() => setMenuOpen(false)}>Отзывы</Link>
        <Link href="/#contacts" onClick={() => setMenuOpen(false)}>Контакты</Link>
      </nav>
      <Link className="premium-header-cta" href="/#contacts">Получить консультацию <ArrowRight size={16} /></Link>
      <button className="premium-menu-button" type="button" onClick={() => setMenuOpen((value) => !value)} aria-label="Меню">{menuOpen ? <X /> : <Menu />}</button>
    </header>
    <div className="dossier-contextbar"><Link href="/catalog"><ArrowLeft size={16} />К каталогу</Link></div>
    <section className="dossier-layout">
      <div className="dossier-content">
        <section className="dossier-vehicle-heading"><div><p>Автомобиль из Южной Кореи · Encar</p><h1>{car.brand} {car.model}</h1><h2>{car.trim}</h2></div><div className="dossier-vehicle-facts"><span>{car.year} год</span><span>{number.format(car.mileage)} км</span><span>{car.engine}</span><span>{car.fuel}</span></div></section>
        <section className="dossier-gallery"><button className="dossier-main-photo" type="button" onTouchStart={beginPhotoSwipe} onTouchEnd={endPhotoSwipe} onClick={() => { if (!suppressPhotoClick.current) openLightbox(); }} aria-label="Открыть фотографию в полном размере"><Image src={car.images[photo] ?? car.images[0]} alt={`${car.brand} ${car.model}`} fill priority sizes="(max-width: 1024px) 100vw, 760px" /><span className={`dossier-history-badge ${historyBadge.tone}`}><ShieldCheck size={14} />{historyBadge.label}</span><small>{photo + 1} / {car.images.length}</small><i><Maximize2 size={18} />Открыть фото</i></button><div className="dossier-thumbs-wrap"><button className="dossier-thumbs-nav is-prev" type="button" onClick={() => scrollThumbnails(-1)} aria-label="Прокрутить фото назад"><ArrowLeft size={17} /></button><div className="dossier-thumbs" ref={thumbsRef} onWheel={(event) => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) { event.preventDefault(); event.currentTarget.scrollBy({ left: event.deltaY, behavior: "smooth" }); } }}>{car.images.map((image, index) => <button key={image} type="button" className={index === photo ? "is-active" : ""} onClick={() => openLightbox(index)} aria-label={`Открыть фото ${index + 1} в полном размере`}><Image src={image} alt={`${car.brand} ${car.model}, фото ${index + 1}`} fill sizes="110px" /></button>)}</div><button className="dossier-thumbs-nav is-next" type="button" onClick={() => scrollThumbnails(1)} aria-label="Прокрутить фото вперёд"><ArrowRight size={17} /></button></div></section>

        <section className="dossier-card"><h2><CarFront />Общие данные</h2><div className="dossier-spec-cards"><div><span>Год регистрации</span><b>{date(car.registrationDate)}</b></div><div><span>Пробег</span><b>{number.format(car.mileage)} км</b></div><div><span>Двигатель</span><b>{car.engine}</b></div><div><span>Топливо</span><b>{car.fuel}</b></div></div><div className="dossier-lines"><div><span>Коробка передач</span><b>{car.transmission}</b></div><div><span>Привод</span><b>{car.drive}</b></div><div><span>Тип кузова</span><b>{car.bodyType}</b></div><div><span>Цвет</span><b>{car.color}</b></div></div></section>

        <section className="dossier-card"><h2><ShieldCheck />История и состояние кузова</h2><BodyConditionMap findings={car.inspection?.bodyFindings ?? []} /><InspectionEvidence images={car.inspection?.inspectionImages ?? []} hasAccident={accident} /><InsuranceBreakdown events={car.accidents?.insuranceEvents ?? []} /><div className="dossier-history-lines"><div><span>Техосмотр Encar</span><b>{car.inspection?.state ?? "Нет данных"}</b></div><div><span>Страховые случаи</span><b>{car.accidents?.accidentCount ?? "Нет данных"}</b></div><div><span>Страховые выплаты</span><b>{car.accidents ? krw(car.accidents.ownAccidentCostKrw + car.accidents.otherAccidentCostKrw) : "Нет данных"}</b></div><div><span>Смена владельцев</span><b>{car.accidents?.ownerChangeCount ?? "Нет данных"}</b></div><div><span>Тотальная гибель / угон</span><b>{car.accidents ? `${car.accidents.totalLossCount} / ${car.accidents.theftCount}` : "Нет данных"}</b></div><div><span>Затопление</span><b>{car.inspection?.waterlog ? "Есть отметка" : "Не заявлено"}</b></div><div><span>Пробег по осмотру</span><b>{car.inspection?.inspectionMileage ? `${number.format(car.inspection.inspectionMileage)} км` : "Нет данных"}</b></div><div><span>VIN</span><b>{car.vinMasked ?? "Скрыт источником"}</b></div></div>{car.inspection?.checks.length ? <details className="dossier-inspection"><summary>Результаты технического осмотра: {car.inspection.checks.length} пунктов <ChevronDown size={17} /></summary><div>{car.inspection.checks.map((check, index) => <p key={`${check.title}-${index}`}><span>{check.title}</span><b>{check.status}</b></p>)}</div></details> : null}</section>

        <section className="dossier-card"><h2><KeyRound />Комплектация</h2><div className="dossier-options">{equipmentCatalog.map((group) => { const installed = group.items.filter(([code]) => standardCodes.has(code)).length; return <details key={group.name}><summary><span><b>{group.name}</b><small>{installed} установлено · не установлено: {group.items.length - installed}</small></span><ChevronDown size={18} /></summary><div>{group.items.map(([code, name]) => { const isInstalled = standardCodes.has(code); return <article className={isInstalled ? "" : "is-missing"} key={`${group.name}-${code}`}><span className="equipment-mark">{isInstalled ? <Check size={13} /> : <X size={13} />}</span><span>{name}<small>{isInstalled ? "Установлено" : "Не установлено"}</small></span></article>; })}</div></details>; })}</div></section>
      </div>

      <aside className="dossier-price"><div className="dossier-source"><span><ShieldCheck size={14} />Источник Encar</span><a href={car.sourceUrl} target="_blank" rel="noreferrer">Оригинал <ExternalLink size={12} /></a></div><div className="dossier-badges"><span>Расчёт для РБ</span><span>Минск</span></div><div className="dossier-total"><span>Предварительная цена под ключ</span><strong>{formatUsdWithByn(calculation.totalUsd, calculation.rates)}</strong><small>{calculation.calculationAvailable ? "с доставкой и оформлением в Беларуси" : calculation.unavailableReason}</small></div><div className="dossier-notice">Предварительный расчёт: итог зависит от курса, даты оформления и параметров автомобиля.</div><div className="dossier-preferential-block"><label className="dossier-preferential"><input type="checkbox" checked={preferential} disabled={!calculation.calculationAvailable} onChange={(event) => setPreferential(event.target.checked)} /><span>Льготная растаможка {preferential ? <b>Включена</b> : <b className="is-off">Выключена</b>}</span></label><small>{preferential ? "Показана предварительная стоимость по льготному режиму. Для расчёта без льготы снимите галочку." : "Показан расчёт без льготы. Льготный режим доступен после подтверждения права на него."}</small></div><ClientPriceTable calculation={calculation} /><Link className="dossier-lead" href="/#contacts">Оставить заявку <ArrowRight size={17} /></Link></aside>
    </section>{lightboxOpen ? <div className="dossier-lightbox" role="dialog" aria-modal="true" aria-label="Просмотр фотографий" onClick={() => setLightboxOpen(false)}><div className="dossier-lightbox-panel" onClick={(event) => event.stopPropagation()}><header><div className="dossier-lightbox-title"><b>{car.brand} {car.model}</b><span>Фото {visiblePhotoIndexes.indexOf(photo) + 1} из {visiblePhotoIndexes.length}</span></div><div className="dossier-lightbox-tools"><button type="button" onClick={() => setZoom((value) => Math.max(1, value - .25))} disabled={zoom === 1} aria-label="Уменьшить"><Minus size={18} /></button><span>{Math.round(zoom * 100)}%</span><button type="button" onClick={() => setZoom((value) => Math.min(2.5, value + .25))} aria-label="Увеличить"><Plus size={18} /></button><button className="dossier-lightbox-close" type="button" onClick={() => setLightboxOpen(false)} aria-label="Закрыть"><X size={20} /></button></div></header><div className={`dossier-lightbox-image ${zoom > 1 ? "is-zoomed" : ""}`} onTouchStart={beginPhotoSwipe} onTouchEnd={endPhotoSwipe} onClick={() => { if (!suppressPhotoClick.current) setZoom((value) => value === 1 ? 1.75 : 1); }}><Image src={car.images[photo] ?? car.images[0]} alt={`${car.brand} ${car.model}, фото ${photo + 1}`} fill priority sizes="100vw" style={{ transform: `scale(${zoom})` }} /></div>{visiblePhotoIndexes.length > 1 ? <><button className="dossier-lightbox-nav is-prev" type="button" onClick={() => changePhoto(-1)} aria-label="Предыдущее фото"><ArrowLeft size={23} /></button><button className="dossier-lightbox-nav is-next" type="button" onClick={() => changePhoto(1)} aria-label="Следующее фото"><ArrowRight size={23} /></button></> : null}<footer><div className="dossier-lightbox-groups">{availableGroups.map((group) => <button type="button" key={group} className={photoGroup === group ? "is-active" : ""} onClick={() => chooseGroup(group)}>{group}</button>)}</div><div className="dossier-lightbox-thumbs">{visiblePhotoIndexes.map((index) => <button type="button" key={car.images[index]} className={index === photo ? "is-active" : ""} onClick={() => { setPhoto(index); setZoom(1); }}><Image src={car.images[index]} alt={`Фото ${index + 1}`} fill sizes="72px" /></button>)}</div></footer></div></div> : null}
  </main>;
}
