"use client";

import { ArrowRight, Search, SlidersHorizontal, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CatalogCar } from "@/data/cars";
import type { CatalogPage, CatalogSearch } from "@/lib/catalog/load-catalog";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const distance = new Intl.NumberFormat("ru-RU");
const fuels = ["", "Бензин", "Дизель", "Гибрид", "Газ"];
const accidentOptions = ["", "clear", "with"] as const;

function badge(car: CatalogCar) {
  if (car.accidents?.accidentCount) return { label: `Страховые случаи: ${car.accidents.accidentCount}`, tone: "is-alert" };
  if (car.accidents?.available || car.inspection) return { label: "Без ДТП", tone: "is-clear" };
  return { label: "История Encar", tone: "is-neutral" };
}

function price(car: CatalogCar) {
  return car.calculation.calculationAvailable ? money.format(car.price) : "Расчёт уточняется";
}

export function HomeCatalog({ catalog, initialSearch }: { catalog: CatalogPage; initialSearch: CatalogSearch }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(initialSearch.query ?? "");
  const [brand, setBrand] = useState(initialSearch.brand ?? "");
  const [model, setModel] = useState(initialSearch.model ?? "");
  const [generation, setGeneration] = useState(initialSearch.generation ?? "");
  const [trim, setTrim] = useState(initialSearch.trim ?? "");
  const [fuel, setFuel] = useState(initialSearch.fuel ?? "");
  const [accidents, setAccidents] = useState(initialSearch.accidents ?? "");
  const [yearFrom, setYearFrom] = useState(String(initialSearch.yearFrom ?? 2021));
  const [yearTo, setYearTo] = useState(String(initialSearch.yearTo ?? 2026));
  const [minEngine, setMinEngine] = useState(String(initialSearch.minEngine ?? ""));
  const [maxEngine, setMaxEngine] = useState(String(initialSearch.maxEngine ?? ""));
  const [minMileage, setMinMileage] = useState(String(initialSearch.minMileage ?? ""));
  const [maxMileage, setMaxMileage] = useState(String(initialSearch.maxMileage ?? 190000));
  const [minPrice, setMinPrice] = useState(String(initialSearch.minPrice ?? ""));
  const [maxPrice, setMaxPrice] = useState(String(initialSearch.maxPrice ?? 100000));
  const models = useMemo(() => [...new Set(catalog.models)], [catalog.models]);

  const navigate = (toCatalog = false) => {
    const params = new URLSearchParams();
    const add = (key: string, value: string) => { if (value) params.set(key, value); };
    add("q", query.trim()); add("brand", brand); add("model", model); add("generation", generation); add("trim", trim); add("fuel", fuel); add("accidents", accidents);
    add("yearFrom", yearFrom); add("yearTo", yearTo); add("minEngine", minEngine); add("maxEngine", maxEngine);
    add("minMileage", minMileage); add("maxMileage", maxMileage); add("minPrice", minPrice); add("maxPrice", maxPrice);
    router.push(`${toCatalog ? "/catalog" : "/"}${params.size ? `?${params.toString()}` : ""}${toCatalog ? "" : "#catalog"}`);
    setOpen(false);
  };

  const reset = () => {
    setQuery(""); setBrand(""); setModel(""); setGeneration(""); setTrim(""); setFuel(""); setAccidents(""); setYearFrom("2021"); setYearTo("2026");
    setMinEngine(""); setMaxEngine(""); setMinMileage(""); setMaxMileage("190000"); setMinPrice(""); setMaxPrice("100000");
    router.push("/#catalog"); setOpen(false);
  };

  return <section className="home-catalog premium-section" id="catalog">
    <div className="home-catalog-heading"><div><p className="premium-kicker"><span />Каталог авто</p><h2>Найдите свой<br />автомобиль</h2><p>Актуальные предложения Encar с расчётом стоимости под ключ в Беларуси.</p></div><button className="home-filter-toggle" type="button" onClick={() => setOpen(!open)}><SlidersHorizontal size={17} />Параметры поиска</button></div>
    <div className={open ? "home-filter-panel is-open" : "home-filter-panel"}>
      <div className="home-filter-title"><b>Фильтр параметров</b><button type="button" onClick={reset}><X size={15} />Сбросить</button></div>
      <div className="home-filter-grid">
        <label className="home-filter-country"><span>🇰🇷</span> Корея</label><label className="home-filter-disabled"><span>Европа</span> скоро</label>
        <label><span>Марка</span><select value={brand} onChange={(e) => { setBrand(e.target.value); setModel(""); setGeneration(""); setTrim(""); }}><option value="">Все марки</option>{catalog.brands.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>Модель</span><select value={model} onChange={(e) => setModel(e.target.value)}><option value="">Все модели</option>{models.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>Поколение</span><select value={generation} onChange={(e) => setGeneration(e.target.value)}><option value="">Любое</option>{catalog.generations.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>Модификация</span><select value={trim} onChange={(e) => setTrim(e.target.value)}><option value="">Любая</option>{catalog.trims.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>Топливо</span><select value={fuel} onChange={(e) => setFuel(e.target.value)}>{fuels.map((value) => <option key={value} value={value}>{value || "Любое"}</option>)}</select></label>
        <label><span>Страховая история</span><select value={accidents} onChange={(e) => setAccidents(e.target.value)}>{accidentOptions.map((value) => <option key={value} value={value}>{value === "" ? "Любая" : value === "clear" ? "Без ДТП" : "Есть страховые случаи"}</option>)}</select></label>
        <label><span>Год от</span><input inputMode="numeric" value={yearFrom} onChange={(e) => setYearFrom(e.target.value)} /></label><label><span>Год до</span><input inputMode="numeric" value={yearTo} onChange={(e) => setYearTo(e.target.value)} /></label>
        <label><span>Объём от, см³</span><input inputMode="numeric" value={minEngine} onChange={(e) => setMinEngine(e.target.value)} placeholder="Любой" /></label><label><span>Объём до, см³</span><input inputMode="numeric" value={maxEngine} onChange={(e) => setMaxEngine(e.target.value)} placeholder="Любой" /></label>
        <label><span>Пробег от, км</span><input inputMode="numeric" value={minMileage} onChange={(e) => setMinMileage(e.target.value)} placeholder="Любой" /></label><label><span>Пробег до, км</span><input inputMode="numeric" value={maxMileage} onChange={(e) => setMaxMileage(e.target.value)} /></label>
        <label><span>Цена от, $</span><input inputMode="numeric" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} placeholder="Любая" /></label><label><span>Цена до, $</span><input inputMode="numeric" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} /></label>
      </div>
      <div className="home-filter-actions"><button className="premium-button primary" type="button" onClick={() => navigate()}>Показать {catalog.total} авто <ArrowRight size={16} /></button><button type="button" onClick={() => navigate(true)}>Открыть каталог</button></div>
    </div>
    <div className="home-results-toolbar"><div><b>{catalog.total} автомобилей</b><span>Показано {catalog.cars.length} актуальных объявлений</span></div><label><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && navigate()} placeholder="Марка или модель" /></label></div>
    {catalog.cars.length ? <div className="home-results-grid">{catalog.cars.map((car) => { const tag = badge(car); return <article className="home-result-card" key={car.id}><Link href={`/catalog/${car.id}`} className="home-result-photo"><Image src={car.images[0]} alt={`${car.brand} ${car.model}`} fill sizes="(max-width: 700px) 50vw, (max-width: 1100px) 33vw, 25vw" /><span className={`result-history-badge ${tag.tone}`}>{tag.label}</span></Link><div><p>{car.location} · Encar</p><h3>{car.brand} {car.model}</h3><small>{car.year} · {distance.format(car.mileage)} км<br />{car.engine} · {car.fuel} · {car.drive}</small><footer><strong>{price(car)}</strong><Link href={`/catalog/${car.id}`}>Подробнее <ArrowRight size={15} /></Link></footer></div></article>; })}</div> : <div className="catalog-preview-empty">По этим параметрам объявлений пока нет. Измените фильтры.</div>}
    <div className="premium-catalog-footer"><button className="premium-button primary" type="button" onClick={() => navigate(true)}>Смотреть весь каталог <ArrowRight size={17} /></button></div>
  </section>;
}
