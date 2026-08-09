"use client";

import { ArrowLeft, ArrowRight, Calculator, CarFront, Check, ChevronDown, ExternalLink, Filter, Gauge, Menu, Search, SlidersHorizontal, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CatalogCar, CarFuel } from "@/data/cars";
import { calculateBelarusPrice } from "@/lib/pricing/emavto-profile";

const fuels: Array<"Все" | CarFuel> = ["Все", "Бензин", "Дизель", "Гибрид", "Электро"];
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const distance = new Intl.NumberFormat("ru-RU");

export function PremiumCatalog({ cars }: { cars: CatalogCar[] }) {
  const brands = useMemo(() => ["Все", ...new Set(cars.map((car) => car.brand))], [cars]);
  const [query, setQuery] = useState("");
  const [brand, setBrand] = useState("Все");
  const [fuel, setFuel] = useState<(typeof fuels)[number]>("Все");
  const [year, setYear] = useState("2021");
  const [maxPrice, setMaxPrice] = useState("100000");
  const [maxMileage, setMaxMileage] = useState("150000");
  const [sort, setSort] = useState("newest");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selected, setSelected] = useState<CatalogCar | null>(null);
  const [selectedImage, setSelectedImage] = useState("");
  const [preferential, setPreferential] = useState(true);

  useEffect(() => {
    document.body.style.overflow = selected || menuOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [menuOpen, selected]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return cars
      .filter((car) => brand === "Все" || car.brand === brand)
      .filter((car) => fuel === "Все" || car.fuel === fuel)
      .filter((car) => car.year >= Number(year) && car.price <= Number(maxPrice) && car.mileage <= Number(maxMileage))
      .filter((car) => !normalized || `${car.brand} ${car.model} ${car.trim}`.toLowerCase().includes(normalized))
      .sort((a, b) => sort === "price-asc" ? a.price - b.price : sort === "price-desc" ? b.price - a.price : b.year - a.year || a.mileage - b.mileage);
  }, [brand, cars, fuel, maxMileage, maxPrice, query, sort, year]);

  const reset = () => { setQuery(""); setBrand("Все"); setFuel("Все"); setYear("2021"); setMaxPrice("100000"); setMaxMileage("150000"); };
  const openCar = (car: CatalogCar) => {
    setSelected(car);
    setSelectedImage(car.images[0]);
    setPreferential(true);
  };
  const detailCalculation = useMemo(
    () =>
      selected
        ? calculateBelarusPrice({
            priceKrw: selected.sourcePriceKrw,
            engineCc: selected.engineCc,
            firstRegistrationDate: selected.registrationDate,
            fuelType: selected.sourceFuel,
            preferential,
          })
        : null,
    [preferential, selected],
  );

  return <main className="catalog-page">
    <header className="catalog-header">
      <Link className="premium-brand" href="/" aria-label="На главную"><span className="premium-brand-mark"><i /><i /></span><span><b>ЧЕСТНЫЙ <em>ПРИГОН</em></b><small>Автомобили из Кореи</small></span></Link>
      <nav className={menuOpen ? "catalog-nav is-open" : "catalog-nav"}><Link href="/">Главная</Link><a className="is-active" href="#catalog-list">Каталог</a><Link href="/#services">Услуги</Link><Link href="/#reviews">Отзывы</Link><Link href="/#contacts">Контакты</Link></nav>
      <Link className="premium-header-cta" href="/#contacts">Получить консультацию <ArrowRight size={16} /></Link>
      <button className="premium-menu-button" type="button" onClick={() => setMenuOpen(!menuOpen)} aria-label="Меню">{menuOpen ? <X /> : <Menu />}</button>
    </header>

    <section className="catalog-intro">
      <div><Link href="/"><ArrowLeft size={15} />На главную</Link><p className="premium-kicker"><span />Каталог Южной Кореи</p><h1>Найдите свой<br />автомобиль</h1><p>Актуальные предложения из Кореи с понятными характеристиками и предварительной ценой в долларах США.</p></div>
      <div className="catalog-intro-stat"><strong>{cars.length} авто</strong><span>первая проверенная выборка из Южной Кореи</span><small>Источник — Encar. Стоимость под ключ рассчитана в USD по предварительному профилю Emavto.</small></div>
    </section>

    <section className="catalog-workspace" id="catalog-list">
      <button className="mobile-filter-trigger" type="button" onClick={() => setFiltersOpen(!filtersOpen)}><Filter size={17} />Фильтры <ChevronDown size={16} /></button>
      <aside className={filtersOpen ? "catalog-filters is-open" : "catalog-filters"}>
        <div className="filter-title"><span><SlidersHorizontal size={18} />Фильтры</span><button type="button" onClick={reset}>Сбросить</button></div>
        <label className="filter-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Марка или модель" /></label>
        <fieldset><legend>Марка</legend><div className="filter-pills">{brands.map((item) => <button className={brand === item ? "is-selected" : ""} type="button" key={item} onClick={() => setBrand(item)}>{item}</button>)}</div></fieldset>
        <label className="filter-select"><span>Год выпуска от</span><select value={year} onChange={(event) => setYear(event.target.value)}><option value="2021">2021</option><option value="2022">2022</option><option value="2023">2023</option><option value="2024">2024</option></select></label>
        <label className="filter-range"><span>Стоимость до <b>{money.format(Number(maxPrice))}</b></span><input type="range" min="15000" max="100000" step="1000" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} /></label>
        <label className="filter-range"><span>Пробег до <b>{distance.format(Number(maxMileage))} км</b></span><input type="range" min="10000" max="150000" step="5000" value={maxMileage} onChange={(event) => setMaxMileage(event.target.value)} /></label>
        <fieldset><legend>Тип двигателя</legend><div className="filter-pills">{fuels.map((item) => <button className={fuel === item ? "is-selected" : ""} type="button" key={item} onClick={() => setFuel(item)}>{item}</button>)}</div></fieldset>
        <button className="apply-filters" type="button" onClick={() => setFiltersOpen(false)}>Показать {visible.length} авто <ArrowRight size={16} /></button>
      </aside>

      <div className="catalog-results">
        <div className="results-toolbar"><div><strong>{visible.length} автомобилей</strong><span>Проверенные данные Encar · предварительная цена под ключ</span></div><label>Сортировка<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">Сначала новые</option><option value="price-asc">Сначала дешевле</option><option value="price-desc">Сначала дороже</option></select></label></div>
        {visible.length ? <div className="catalog-result-grid">{visible.map((car) => <article className="result-car" key={car.id}>
          <button className="result-car-media" type="button" onClick={() => openCar(car)}><Image src={car.images[0]} alt={`${car.brand} ${car.model}`} fill sizes="(max-width: 760px) 100vw, 33vw" /><span>{car.status}</span><small>КОРЕЯ 🇰🇷</small></button>
          <div className="result-car-body"><p>{car.location} · Encar</p><h2>{car.brand} {car.model}</h2><h3>{car.trim}</h3><div className="result-specs"><span><CarFront />{car.year}</span><span><Gauge />{distance.format(car.mileage)} км</span><span>{car.engine}</span><span>{car.fuel}</span><span>{car.drive}</span></div><footer><div><strong>{money.format(car.price)}</strong><small>под ключ в Минске</small></div><button type="button" onClick={() => openCar(car)}>Подробнее <ArrowRight size={15} /></button></footer></div>
        </article>)}</div> : <div className="catalog-no-results"><Search /><h2>Подходящих автомобилей не найдено</h2><p>Измените параметры или сбросьте фильтры.</p><button type="button" onClick={reset}>Сбросить фильтры</button></div>}
      </div>
    </section>

    <section className="catalog-consult"><div><p className="premium-kicker"><span />Не нашли подходящий вариант?</p><h2>Подберём автомобиль<br />под ваш запрос</h2><p>Оставьте критерии — менеджер подготовит персональную подборку.</p></div><Link href="/#contacts">Получить подборку <ArrowRight /></Link></section>
    <footer className="catalog-simple-footer"><Link href="/">ЧЕСТНЫЙ <em>ПРИГОН</em></Link><span>Автомобили из Кореи с доставкой в Беларусь</span><a href="tel:+375447543987">+375 (44) 754-39-87</a></footer>

    {selected && detailCalculation && <div className="car-detail-backdrop" onMouseDown={() => setSelected(null)}><article className="car-detail" role="dialog" aria-modal="true" aria-label={`${selected.brand} ${selected.model}`} onMouseDown={(event) => event.stopPropagation()}><button className="car-detail-close" type="button" onClick={() => setSelected(null)}><X /></button><div className="car-detail-gallery"><div className="car-detail-image"><Image src={selectedImage || selected.images[0]} alt={`${selected.brand} ${selected.model}`} fill sizes="600px" /><span>{selected.status}</span></div><div className="car-detail-thumbs">{selected.images.slice(0, 8).map((image, index) => <button className={image === selectedImage ? "is-active" : ""} type="button" key={image} onClick={() => setSelectedImage(image)}><Image src={image} alt={`${selected.brand} ${selected.model}, фото ${index + 1}`} fill sizes="90px" /></button>)}</div></div><div className="car-detail-copy"><p className="premium-kicker"><span />Автомобиль из Кореи</p><h2>{selected.brand} {selected.model}</h2><h3>{selected.trim}</h3><ul><li><span>Год / регистрация</span><b>{selected.year}{selected.registrationDate ? ` · ${selected.registrationDate.slice(0, 7)}` : ""}</b></li><li><span>Пробег</span><b>{distance.format(selected.mileage)} км</b></li><li><span>Двигатель</span><b>{selected.engine} · {selected.fuel}</b></li><li><span>Привод / кузов</span><b>{selected.drive}{selected.bodyType ? ` · ${selected.bodyType}` : ""}</b></li><li><span>Цвет</span><b>{selected.color ?? "Не указан"}</b></li></ul><section className="detail-calculation"><header><span><Calculator size={15} />Расчёт под ключ</span><label><input type="checkbox" checked={preferential} disabled={selected.fuel === "Электро"} onChange={(event) => setPreferential(event.target.checked)} />Льготная растаможка</label></header><dl><div><dt>Авто и расходы в Корее</dt><dd>{money.format(detailCalculation.koreaAndExportUsd)}</dd></div><div><dt>Доставка до Минска</dt><dd>{money.format(detailCalculation.deliveryUsd)}</dd></div><div><dt>Транзитная декларация</dt><dd>{money.format(detailCalculation.transitUsd)}</dd></div><div><dt>Растаможка</dt><dd>{money.format(detailCalculation.customsDutyUsd)}</dd></div><div><dt>СВХ, платежи и утиль</dt><dd>{money.format(detailCalculation.customsServicesUsd)}</dd></div><div><dt>Подбор и сопровождение</dt><dd>{money.format(detailCalculation.companyServicesUsd)}</dd></div></dl></section><div className="car-detail-price"><span>Предварительная стоимость под ключ</span><strong>{money.format(detailCalculation.totalUsd)}</strong><small>Расчёт по структуре Emavto и курсам из контрольного HAR от 07.08.2026. Финальная цена уточняется менеджером.</small></div><Link href={`/#contacts`} onClick={() => setSelected(null)}>Запросить точный расчёт <ArrowRight size={17} /></Link><a className="detail-source" href={selected.sourceUrl} target="_blank" rel="noreferrer">Открыть исходное объявление Encar <ExternalLink size={13} /></a><p className="detail-note"><Check size={14} />Объявление прошло автоматическую проверку перед публикацией.</p></div></article></div>}
  </main>;
}
