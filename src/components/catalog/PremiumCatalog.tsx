"use client";

import { ArrowLeft, ArrowRight, CarFront, Check, ChevronDown, Filter, Gauge, Menu, Search, SlidersHorizontal, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { catalogCars, CatalogCar, CarFuel } from "@/data/cars";

const brands = ["Все", "Genesis", "Hyundai", "Kia"] as const;
const fuels: Array<"Все" | CarFuel> = ["Все", "Бензин", "Дизель", "Гибрид", "Электро"];
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const distance = new Intl.NumberFormat("ru-RU");

export function PremiumCatalog() {
  const [query, setQuery] = useState("");
  const [brand, setBrand] = useState<(typeof brands)[number]>("Все");
  const [fuel, setFuel] = useState<(typeof fuels)[number]>("Все");
  const [year, setYear] = useState("2021");
  const [maxPrice, setMaxPrice] = useState("45000");
  const [maxMileage, setMaxMileage] = useState("80000");
  const [sort, setSort] = useState("newest");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selected, setSelected] = useState<CatalogCar | null>(null);

  useEffect(() => {
    document.body.style.overflow = selected || menuOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [menuOpen, selected]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return catalogCars
      .filter((car) => brand === "Все" || car.brand === brand)
      .filter((car) => fuel === "Все" || car.fuel === fuel)
      .filter((car) => car.year >= Number(year) && car.price <= Number(maxPrice) && car.mileage <= Number(maxMileage))
      .filter((car) => !normalized || `${car.brand} ${car.model} ${car.trim}`.toLowerCase().includes(normalized))
      .sort((a, b) => sort === "price-asc" ? a.price - b.price : sort === "price-desc" ? b.price - a.price : b.year - a.year || a.mileage - b.mileage);
  }, [brand, fuel, maxMileage, maxPrice, query, sort, year]);

  const reset = () => { setQuery(""); setBrand("Все"); setFuel("Все"); setYear("2021"); setMaxPrice("45000"); setMaxMileage("80000"); };

  return <main className="catalog-page">
    <header className="catalog-header">
      <Link className="premium-brand" href="/" aria-label="На главную"><span className="premium-brand-mark"><i /><i /></span><span><b>ЧЕСТНЫЙ <em>ПРИГОН</em></b><small>Автомобили из Кореи</small></span></Link>
      <nav className={menuOpen ? "catalog-nav is-open" : "catalog-nav"}><Link href="/">Главная</Link><a className="is-active" href="#catalog-list">Каталог</a><Link href="/#services">Услуги</Link><Link href="/#reviews">Отзывы</Link><Link href="/#contacts">Контакты</Link></nav>
      <Link className="premium-header-cta" href="/#contacts">Получить консультацию <ArrowRight size={16} /></Link>
      <button className="premium-menu-button" type="button" onClick={() => setMenuOpen(!menuOpen)} aria-label="Меню">{menuOpen ? <X /> : <Menu />}</button>
    </header>

    <section className="catalog-intro">
      <div><Link href="/"><ArrowLeft size={15} />На главную</Link><p className="premium-kicker"><span />Каталог Южной Кореи</p><h1>Найдите свой<br />автомобиль</h1><p>Актуальные предложения из Кореи с понятными характеристиками и предварительной ценой в долларах США.</p></div>
      <div className="catalog-intro-stat"><strong>50–80 тыс.</strong><span>целевой объём после полного подключения источника</span><small>Сейчас показан согласуемый интерфейс на демонстрационных данных</small></div>
    </section>

    <section className="catalog-workspace" id="catalog-list">
      <button className="mobile-filter-trigger" type="button" onClick={() => setFiltersOpen(!filtersOpen)}><Filter size={17} />Фильтры <ChevronDown size={16} /></button>
      <aside className={filtersOpen ? "catalog-filters is-open" : "catalog-filters"}>
        <div className="filter-title"><span><SlidersHorizontal size={18} />Фильтры</span><button type="button" onClick={reset}>Сбросить</button></div>
        <label className="filter-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Марка или модель" /></label>
        <fieldset><legend>Марка</legend><div className="filter-pills">{brands.map((item) => <button className={brand === item ? "is-selected" : ""} type="button" key={item} onClick={() => setBrand(item)}>{item}</button>)}</div></fieldset>
        <label className="filter-select"><span>Год выпуска от</span><select value={year} onChange={(event) => setYear(event.target.value)}><option value="2021">2021</option><option value="2022">2022</option><option value="2023">2023</option><option value="2024">2024</option></select></label>
        <label className="filter-range"><span>Стоимость до <b>{money.format(Number(maxPrice))}</b></span><input type="range" min="20000" max="50000" step="1000" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} /></label>
        <label className="filter-range"><span>Пробег до <b>{distance.format(Number(maxMileage))} км</b></span><input type="range" min="10000" max="100000" step="5000" value={maxMileage} onChange={(event) => setMaxMileage(event.target.value)} /></label>
        <fieldset><legend>Тип двигателя</legend><div className="filter-pills">{fuels.map((item) => <button className={fuel === item ? "is-selected" : ""} type="button" key={item} onClick={() => setFuel(item)}>{item}</button>)}</div></fieldset>
        <button className="apply-filters" type="button" onClick={() => setFiltersOpen(false)}>Показать {visible.length} авто <ArrowRight size={16} /></button>
      </aside>

      <div className="catalog-results">
        <div className="results-toolbar"><div><strong>{visible.length} автомобилей</strong><span>Демонстрационная выборка</span></div><label>Сортировка<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">Сначала новые</option><option value="price-asc">Сначала дешевле</option><option value="price-desc">Сначала дороже</option></select></label></div>
        {visible.length ? <div className="catalog-result-grid">{visible.map((car) => <article className="result-car" key={car.id}>
          <button className="result-car-media" type="button" onClick={() => setSelected(car)}><Image src={car.image} alt={`${car.brand} ${car.model}`} fill sizes="(max-width: 760px) 100vw, 33vw" /><span>{car.status}</span><small>КОРЕЯ 🇰🇷</small></button>
          <div className="result-car-body"><p>{car.location} · Encar</p><h2>{car.brand} {car.model}</h2><h3>{car.trim}</h3><div className="result-specs"><span><CarFront />{car.year}</span><span><Gauge />{distance.format(car.mileage)} км</span><span>{car.engine}</span><span>{car.fuel}</span><span>{car.drive}</span></div><footer><strong>{money.format(car.price)}</strong><button type="button" onClick={() => setSelected(car)}>Подробнее <ArrowRight size={15} /></button></footer></div>
        </article>)}</div> : <div className="catalog-no-results"><Search /><h2>Подходящих автомобилей не найдено</h2><p>Измените параметры или сбросьте фильтры.</p><button type="button" onClick={reset}>Сбросить фильтры</button></div>}
      </div>
    </section>

    <section className="catalog-consult"><div><p className="premium-kicker"><span />Не нашли подходящий вариант?</p><h2>Подберём автомобиль<br />под ваш запрос</h2><p>Оставьте критерии — менеджер подготовит персональную подборку.</p></div><Link href="/#contacts">Получить подборку <ArrowRight /></Link></section>
    <footer className="catalog-simple-footer"><Link href="/">ЧЕСТНЫЙ <em>ПРИГОН</em></Link><span>Автомобили из Кореи с доставкой в Беларусь</span><a href="tel:+375447543987">+375 (44) 754-39-87</a></footer>

    {selected && <div className="car-detail-backdrop" onMouseDown={() => setSelected(null)}><article className="car-detail" role="dialog" aria-modal="true" aria-label={`${selected.brand} ${selected.model}`} onMouseDown={(event) => event.stopPropagation()}><button className="car-detail-close" type="button" onClick={() => setSelected(null)}><X /></button><div className="car-detail-image"><Image src={selected.image} alt={`${selected.brand} ${selected.model}`} fill sizes="600px" /><span>{selected.status}</span></div><div className="car-detail-copy"><p className="premium-kicker"><span />Автомобиль из Кореи</p><h2>{selected.brand} {selected.model}</h2><h3>{selected.trim}</h3><ul><li><span>Год</span><b>{selected.year}</b></li><li><span>Пробег</span><b>{distance.format(selected.mileage)} км</b></li><li><span>Двигатель</span><b>{selected.engine} · {selected.fuel}</b></li><li><span>Привод</span><b>{selected.drive}</b></li><li><span>Город</span><b>{selected.location}</b></li></ul><div className="car-detail-price"><span>Цена автомобиля</span><strong>{money.format(selected.price)}</strong><small>Предварительно, без расчёта доставки и таможенных платежей</small></div><Link href={`/#contacts`} onClick={() => setSelected(null)}>Запросить расчёт <ArrowRight size={17} /></Link><p className="detail-note"><Check size={14} />На следующем этапе карточка получит реальные фото, VIN-данные и историю.</p></div></article></div>}
  </main>;
}
