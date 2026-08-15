"use client";

import {
  ArrowLeft,
  ArrowRight,
  CarFront,
  ChevronDown,
  Filter,
  Gauge,
  Menu,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { CatalogCar, CarFuel } from "@/data/cars";
import type { CatalogPage, CatalogSearch } from "@/lib/catalog/load-catalog";

const fuels: Array<"Все" | CarFuel> = ["Все", "Бензин", "Дизель", "Гибрид", "Электро"];
const transmissions = ["Все", "Автомат", "Механика", "Вариатор"] as const;
const drives = ["Все", "Полный", "Передний", "Задний", "2WD"] as const;
const bodyTypes = ["Все", "SUV", "Седан", "Минивэн", "Хэтчбек", "Купе", "Универсал", "Пикап"] as const;
const accidentFilters = ["Все", "Без ДТП", "Есть страховые случаи"] as const;
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const distance = new Intl.NumberFormat("ru-RU");

function freshnessDate(car: CatalogCar) {
  const value = car.sourceUpdatedAt ?? car.publishedAt ?? car.lastSeenAt;
  if (!value) return "Дата уточняется";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "Дата уточняется";
  return `Обновлено ${new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short" }).format(parsed)}`;
}

function historyBadge(car: CatalogCar) {
  if (car.accidents?.accidentCount) return { label: `Страховые случаи: ${car.accidents.accidentCount}`, tone: "is-alert" };
  if (car.accidents?.available || car.inspection) return { label: "Без ДТП", tone: "is-clear" };
  return { label: "История Encar", tone: "is-neutral" };
}

export function PremiumCatalog({ catalog, initialSearch }: { catalog: CatalogPage; initialSearch: CatalogSearch }) {
  const { cars } = catalog;
  const router = useRouter();
  const brands = ["Все", ...catalog.brands];
  const [query, setQuery] = useState(initialSearch.query ?? "");
  const [brand, setBrand] = useState(initialSearch.brand ?? "Все");
  const [model, setModel] = useState(initialSearch.model ?? "Все");
  const [fuel, setFuel] = useState<(typeof fuels)[number]>((initialSearch.fuel as (typeof fuels)[number]) ?? "Все");
  const [yearFrom, setYearFrom] = useState(String(initialSearch.yearFrom ?? 2021));
  const [yearTo, setYearTo] = useState(String(initialSearch.yearTo ?? 2026));
  const [minPrice, setMinPrice] = useState(String(initialSearch.minPrice ?? 0));
  const [maxPrice, setMaxPrice] = useState(String(initialSearch.maxPrice ?? 100000));
  const [maxMileage, setMaxMileage] = useState(String(initialSearch.maxMileage ?? 150000));
  const [transmission, setTransmission] = useState<(typeof transmissions)[number]>((initialSearch.transmission as (typeof transmissions)[number]) ?? "Все");
  const [drive, setDrive] = useState<(typeof drives)[number]>((initialSearch.drive as (typeof drives)[number]) ?? "Все");
  const [bodyType, setBodyType] = useState<(typeof bodyTypes)[number]>((initialSearch.bodyType as (typeof bodyTypes)[number]) ?? "Все");
  const [accidentFilter, setAccidentFilter] = useState<(typeof accidentFilters)[number]>(initialSearch.accidents === "clear" ? "Без ДТП" : initialSearch.accidents === "with" ? "Есть страховые случаи" : "Все");
  const [sort, setSort] = useState(initialSearch.sort ?? "newest");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const models = useMemo(() => ["Все", ...new Set([...catalog.models, ...cars.filter((car) => brand === "Все" || car.brand === brand).map((car) => car.model)])], [brand, cars, catalog.models]);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  const visible = cars;

  const applySearch = (page = 1) => {
    const params = new URLSearchParams();
    const add = (key: string, value: string, fallback: string) => { if (value && value !== fallback) params.set(key, value); };
    add("q", query.trim(), ""); add("brand", brand, "Все"); add("model", model, "Все"); add("fuel", fuel, "Все");
    add("yearFrom", yearFrom, "2021"); add("yearTo", yearTo, "2026"); add("minPrice", minPrice, "0"); add("maxPrice", maxPrice, "100000"); add("maxMileage", maxMileage, "150000");
    add("transmission", transmission, "Все"); add("drive", drive, "Все"); add("bodyType", bodyType, "Все"); add("sort", sort, "newest");
    if (accidentFilter === "Без ДТП") params.set("accidents", "clear");
    if (accidentFilter === "Есть страховые случаи") params.set("accidents", "with");
    if (page > 1) params.set("page", String(page));
    router.push(`/catalog${params.size ? `?${params.toString()}` : ""}`);
    setFiltersOpen(false);
  };

  const reset = () => {
    setQuery("");
    setBrand("Все");
    setModel("Все");
    setFuel("Все");
    setYearFrom("2021");
    setYearTo("2026");
    setMinPrice("0");
    setMaxPrice("100000");
    setMaxMileage("150000");
    setTransmission("Все");
    setDrive("Все");
    setBodyType("Все");
    setAccidentFilter("Все");
    setSort("newest");
    router.push("/catalog");
  };
  return (
    <main className="catalog-page">
      <header className="catalog-header">
        <Link className="premium-brand" href="/" aria-label="На главную"><span className="premium-brand-art"><Image className="premium-brand-mark" src="/assets/logo-header-dark.png" alt="Честный пригон" width={2172} height={724} priority /></span></Link>
        <nav className={menuOpen ? "catalog-nav is-open" : "catalog-nav"}><Link href="/">Главная</Link><a className="is-active" href="#catalog-list">Каталог</a><Link href="/#services">Услуги</Link><Link href="/#reviews">Отзывы</Link><Link href="/#contacts">Контакты</Link></nav>
        <Link className="premium-header-cta" href="/#contacts">Получить консультацию <ArrowRight size={16} /></Link>
        <button className="premium-menu-button" type="button" onClick={() => setMenuOpen(!menuOpen)} aria-label="Меню">{menuOpen ? <X /> : <Menu />}</button>
      </header>

      <section className="catalog-intro">
        <div><Link href="/"><ArrowLeft size={15} />На главную</Link><p className="premium-kicker"><span />Каталог Южной Кореи</p><h1>Авто из Кореи<br />под ключ</h1><p>Проверенные объявления Encar с подробной карточкой, опциями и предварительной стоимостью под ключ.</p></div>
        <div className="catalog-intro-stat"><strong>{catalog.total} авто</strong><span>прошли автоматическую проверку</span><small>Исключаем аренду, такси и коммерческий транспорт. Историю ДТП и страховых выплат показываем открыто.</small></div>
      </section>

      <section className="catalog-workspace" id="catalog-list">
        <button className="mobile-filter-trigger" type="button" onClick={() => setFiltersOpen(!filtersOpen)}><Filter size={17} />Фильтры <ChevronDown size={16} /></button>
        <aside className={filtersOpen ? "catalog-filters is-open" : "catalog-filters"}>
          <div className="filter-title"><span><SlidersHorizontal size={18} />Фильтры</span><button type="button" onClick={reset}>Сбросить</button></div>
          <label className="filter-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Марка или модель" /></label>
          <fieldset><legend>Марка</legend><div className="filter-pills">{brands.map((item) => <button className={brand === item ? "is-selected" : ""} type="button" key={item} onClick={() => { setBrand(item); setModel("Все"); }}>{item}</button>)}</div></fieldset>
          <label className="filter-select"><span>Модель</span><select value={model} onChange={(event) => setModel(event.target.value)}>{models.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <div className="filter-pair"><label className="filter-select"><span>Год от</span><select value={yearFrom} onChange={(event) => setYearFrom(event.target.value)}>{[2021, 2022, 2023, 2024, 2025, 2026].map((item) => <option key={item}>{item}</option>)}</select></label><label className="filter-select"><span>до</span><select value={yearTo} onChange={(event) => setYearTo(event.target.value)}>{[2021, 2022, 2023, 2024, 2025, 2026].map((item) => <option key={item}>{item}</option>)}</select></label></div>
          <div className="filter-pair"><label className="filter-select"><span>Цена от, $</span><select value={minPrice} onChange={(event) => setMinPrice(event.target.value)}>{[0, 15000, 25000, 40000, 60000].map((item) => <option key={item} value={item}>{item ? money.format(item) : "Любая"}</option>)}</select></label><label className="filter-select"><span>до, $</span><select value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)}>{[20000, 30000, 50000, 75000, 100000].map((item) => <option key={item} value={item}>{money.format(item)}</option>)}</select></label></div>
          <label className="filter-range"><span>Пробег до <b>{distance.format(Number(maxMileage))} км</b></span><input type="range" min="10000" max="150000" step="5000" value={maxMileage} onChange={(event) => setMaxMileage(event.target.value)} /></label>
          <fieldset><legend>Тип двигателя</legend><div className="filter-pills">{fuels.map((item) => <button className={fuel === item ? "is-selected" : ""} type="button" key={item} onClick={() => setFuel(item)}>{item}</button>)}</div></fieldset>
          <fieldset><legend>Коробка передач</legend><div className="filter-pills">{transmissions.map((item) => <button className={transmission === item ? "is-selected" : ""} type="button" key={item} onClick={() => setTransmission(item)}>{item}</button>)}</div></fieldset>
          <fieldset><legend>Привод</legend><div className="filter-pills">{drives.map((item) => <button className={drive === item ? "is-selected" : ""} type="button" key={item} onClick={() => setDrive(item)}>{item}</button>)}</div></fieldset>
          <fieldset><legend>Кузов</legend><div className="filter-pills">{bodyTypes.map((item) => <button className={bodyType === item ? "is-selected" : ""} type="button" key={item} onClick={() => setBodyType(item)}>{item}</button>)}</div></fieldset>
          <fieldset><legend>История Encar</legend><div className="filter-pills">{accidentFilters.map((item) => <button className={accidentFilter === item ? "is-selected" : ""} type="button" key={item} onClick={() => setAccidentFilter(item)}>{item}</button>)}</div></fieldset>
          <button className="apply-filters" type="button" onClick={() => applySearch()}>Показать {catalog.total} авто <ArrowRight size={16} /></button>
        </aside>

        <div className="catalog-results">
          <div className="results-toolbar"><div><strong>{catalog.total} автомобилей</strong><span>Показано {visible.length} из {catalog.total} · Encar · проверка перед публикацией</span></div><label>Сортировка<select value={sort} onChange={(event) => { setSort(event.target.value as "newest" | "price-asc" | "price-desc"); setTimeout(() => applySearch(), 0); }}><option value="newest">Сначала новые</option><option value="price-asc">Сначала дешевле</option><option value="price-desc">Сначала дороже</option></select></label></div>
          {visible.length ? <div className="catalog-result-grid">{visible.map((car) => { const badge = historyBadge(car); return <article className="result-car" key={car.id}>
            <Link className="result-car-media" href={`/catalog/${car.id}`}><Image src={car.images[0]} alt={`${car.brand} ${car.model}`} fill sizes="(max-width: 760px) 100vw, 33vw" /><span className={`result-history-badge ${badge.tone}`}>{badge.label}</span></Link>
            <div className="result-car-body"><p><span>{car.location} · Encar</span><small className="listing-freshness">{freshnessDate(car)}</small></p><h2>{car.brand} {car.model}</h2><h3>{car.trim}</h3><div className="result-specs"><span><CarFront />{car.year}</span><span><Gauge />{distance.format(car.mileage)} км</span><span>{car.engine}</span><span>{car.fuel}</span><span>{car.drive}</span></div><footer><div><strong>{money.format(car.price)}</strong><small>под ключ в Минске</small></div></footer></div>
          </article>; })}</div> : <div className="catalog-no-results"><Search /><h2>Подходящих автомобилей не найдено</h2><p>Измените параметры или сбросьте фильтры.</p><button type="button" onClick={reset}>Сбросить фильтры</button></div>}
          {visible.length > 0 && (catalog.page > 1 || catalog.hasMore) ? <div className="catalog-pagination">{catalog.page > 1 ? <button type="button" onClick={() => applySearch(catalog.page - 1)}><ArrowLeft size={16} />Предыдущие</button> : null}<span>Страница {catalog.page}</span>{catalog.hasMore ? <button type="button" onClick={() => applySearch(catalog.page + 1)}>Следующие {catalog.perPage} авто <ArrowRight size={16} /></button> : null}</div> : null}
        </div>
      </section>

      <section className="catalog-consult"><div><p className="premium-kicker"><span />Не нашли подходящий вариант?</p><h2>Подберём автомобиль<br />под ваш запрос</h2><p>Оставьте критерии — менеджер подготовит персональную подборку.</p></div><Link href="/#contacts">Получить подборку <ArrowRight /></Link></section>
      <footer className="catalog-simple-footer"><Link href="/">ЧЕСТНЫЙ <em>ПРИГОН</em></Link><span>Автомобили из Кореи с доставкой в Беларусь</span><a href="tel:+375447543987">+375 (44) 754-39-87</a></footer>

    </main>
  );
}
