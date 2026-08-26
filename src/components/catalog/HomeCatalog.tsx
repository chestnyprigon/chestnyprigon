"use client";

import { ArrowRight, Search, SlidersHorizontal, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CatalogCar } from "@/data/cars";
import type { CatalogPage, CatalogSearch } from "@/lib/catalog/load-catalog";
import {
  ENGINE_MAX_OPTIONS,
  ENGINE_MIN_OPTIONS,
  MILEAGE_MAX_OPTIONS,
  MILEAGE_MIN_OPTIONS,
  PRICE_MAX_OPTIONS,
  PRICE_MIN_OPTIONS,
  YEAR_OPTIONS,
} from "@/lib/catalog/filter-options";
import { useCatalogFilterCount } from "@/hooks/use-catalog-filter-count";
import { CATALOG_MAX_MILEAGE_KM, catalogYearFrom, catalogYearTo } from "@/lib/catalog/catalog-rules";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const distance = new Intl.NumberFormat("ru-RU");
const fuels = ["", "Бензин", "Дизель", "Гибрид", "Газ"];
const drives = ["", "Полный", "Передний", "Задний", "2WD"];
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
  const [open, setOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [query, setQuery] = useState(initialSearch.query ?? "");
  const [brand, setBrand] = useState(initialSearch.brand ?? "");
  const [model, setModel] = useState(initialSearch.model ?? "");
  const [fuel, setFuel] = useState(initialSearch.fuel ?? "");
  const [drive, setDrive] = useState(initialSearch.drive ?? "");
  const [accidents, setAccidents] = useState(initialSearch.accidents ?? "");
  const [yearFrom, setYearFrom] = useState(String(initialSearch.yearFrom ?? catalogYearFrom()));
  const [yearTo, setYearTo] = useState(String(initialSearch.yearTo ?? catalogYearTo()));
  const [minEngine, setMinEngine] = useState(String(initialSearch.minEngine ?? ""));
  const [maxEngine, setMaxEngine] = useState(String(initialSearch.maxEngine ?? ""));
  const [minMileage, setMinMileage] = useState(String(initialSearch.minMileage ?? ""));
  const [maxMileage, setMaxMileage] = useState(String(initialSearch.maxMileage ?? CATALOG_MAX_MILEAGE_KM));
  const [minPrice, setMinPrice] = useState(String(initialSearch.minPrice ?? ""));
  const [maxPrice, setMaxPrice] = useState(String(initialSearch.maxPrice ?? 100000));
  const [modelOptions, setModelOptions] = useState<string[]>(catalog.models);
  const { total: matchingTotal, pending: isCounting } = useCatalogFilterCount({
    q: query.trim(), brand, model, fuel, drive, accidents,
    yearFrom, yearTo, minEngine, maxEngine, minMileage, maxMileage, minPrice, maxPrice,
  }, catalog.total);
  const models = useMemo(
    () => [...new Set([...modelOptions, ...catalog.cars.filter((car) => !brand || car.brand === brand).map((car) => car.model)])].sort((left, right) => left.localeCompare(right, "ru")),
    [brand, catalog.cars, modelOptions],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/catalog/models${brand ? `?brand=${encodeURIComponent(brand)}` : ""}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { models?: unknown } | null) => {
        if (Array.isArray(payload?.models)) setModelOptions(payload.models.filter((item): item is string => typeof item === "string"));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [brand]);

  const navigate = (toCatalog = false) => {
    const params = new URLSearchParams();
    const add = (key: string, value: string) => { if (value) params.set(key, value); };
    add("q", query.trim()); add("brand", brand); add("model", model); add("fuel", fuel); add("drive", drive); add("accidents", accidents);
    add("yearFrom", yearFrom); add("yearTo", yearTo); add("minEngine", minEngine); add("maxEngine", maxEngine);
    add("minMileage", minMileage); add("maxMileage", maxMileage); add("minPrice", minPrice); add("maxPrice", maxPrice);
    router.push(`${toCatalog ? "/catalog" : "/"}${params.size ? `?${params.toString()}` : ""}${toCatalog ? "" : "#catalog"}`);
    setOpen(false);
  };

  const reset = () => {
    setQuery(""); setBrand(""); setModel(""); setFuel(""); setDrive(""); setAccidents(""); setYearFrom(String(catalogYearFrom())); setYearTo(String(catalogYearTo())); setAdvancedOpen(false);
    setMinEngine(""); setMaxEngine(""); setMinMileage(""); setMaxMileage(String(CATALOG_MAX_MILEAGE_KM)); setMinPrice(""); setMaxPrice("100000");
    router.push("/#catalog"); setOpen(false);
  };

  return <section className="home-catalog premium-section" id="catalog">
    <div className="home-catalog-heading"><div><p className="premium-kicker"><span />Каталог авто</p><h2>Найдите свой<br />автомобиль</h2><p>Актуальные предложения Encar с расчётом стоимости под ключ в Беларуси.</p></div><button className="home-filter-toggle" type="button" onClick={() => setOpen(!open)}><SlidersHorizontal size={17} />{open ? "Свернуть параметры" : "Параметры поиска"}</button></div>
    <div className={`${open ? "home-filter-panel is-open" : "home-filter-panel"} ${advancedOpen ? "is-advanced" : ""}`}>
      <div className="home-filter-title"><b>Фильтр параметров</b><button type="button" onClick={reset}><X size={15} />Сбросить</button></div>
      <div className="home-filter-grid">
        <label className="home-filter-country"><span>🇰🇷</span> Корея</label>
        <label><span>Марка</span><select value={brand} onChange={(e) => { setBrand(e.target.value); setModel(""); }}><option value="">Все марки</option>{catalog.brands.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>Модель</span><select value={model} onChange={(e) => setModel(e.target.value)}><option value="">Все модели</option>{models.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>Топливо</span><select value={fuel} onChange={(e) => setFuel(e.target.value)}>{fuels.map((value) => <option key={value} value={value}>{value || "Любое"}</option>)}</select></label>
        <label className="home-filter-advanced"><span>Привод</span><select value={drive} onChange={(e) => setDrive(e.target.value)}>{drives.map((value) => <option key={value} value={value}>{value || "Любой"}</option>)}</select></label>
        <label className="home-filter-advanced"><span>Страховая история</span><select value={accidents} onChange={(e) => setAccidents(e.target.value)}>{accidentOptions.map((value) => <option key={value} value={value}>{value === "" ? "Любая" : value === "clear" ? "Без ДТП" : "Есть страховые случаи"}</option>)}</select></label>
        <label><span>Год от</span><select value={yearFrom} onChange={(e) => setYearFrom(e.target.value)}>{YEAR_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label><span>Год до</span><select value={yearTo} onChange={(e) => setYearTo(e.target.value)}>{YEAR_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="home-filter-advanced"><span>Объём от</span><select value={minEngine} onChange={(e) => setMinEngine(e.target.value)}><option value="0">Любой</option>{ENGINE_MIN_OPTIONS.filter(Boolean).map((value) => <option key={value} value={value}>{(value / 1_000).toFixed(1)} л</option>)}</select></label><label className="home-filter-advanced"><span>Объём до</span><select value={maxEngine} onChange={(e) => setMaxEngine(e.target.value)}>{ENGINE_MAX_OPTIONS.map((value) => <option key={value} value={value}>{value === 8_000 ? "Любой" : `${(value / 1_000).toFixed(1)} л`}</option>)}</select></label>
        <label className="home-filter-advanced"><span>Пробег от</span><select value={minMileage} onChange={(e) => setMinMileage(e.target.value)}><option value="0">Любой</option>{MILEAGE_MIN_OPTIONS.filter(Boolean).map((value) => <option key={value} value={value}>{distance.format(value)} км</option>)}</select></label><label className="home-filter-advanced"><span>Пробег до</span><select value={maxMileage} onChange={(e) => setMaxMileage(e.target.value)}>{MILEAGE_MAX_OPTIONS.map((value) => <option key={value} value={value}>{distance.format(value)} км</option>)}</select></label>
        <label><span>Цена от</span><select value={minPrice} onChange={(e) => setMinPrice(e.target.value)}><option value="0">Любая</option>{PRICE_MIN_OPTIONS.filter(Boolean).map((value) => <option key={value} value={value}>{money.format(value)}</option>)}</select></label><label><span>Цена до</span><select value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)}>{PRICE_MAX_OPTIONS.map((value) => <option key={value} value={value}>{value === 100_000 ? "Любая" : money.format(value)}</option>)}</select></label>
      </div>
      <button className="home-filter-advanced-toggle" type="button" onClick={() => setAdvancedOpen(!advancedOpen)}>{advancedOpen ? "Скрыть дополнительные параметры" : "Дополнительные параметры"}<span>{advancedOpen ? "−" : "+"}</span></button>
      <div className="home-filter-actions"><button className="premium-button primary" type="button" onClick={() => navigate()}>{isCounting ? "Подсчитываем…" : `Показать ${matchingTotal} авто`} <ArrowRight size={16} /></button><button type="button" onClick={() => navigate(true)}>Открыть каталог</button></div>
    </div>
    <div className="home-results-toolbar"><div><b>{catalog.total} автомобилей</b><span>Показано {catalog.cars.length} актуальных объявлений</span></div><label><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && navigate()} placeholder="Марка или модель" /></label></div>
    {catalog.cars.length ? <div className="home-results-grid">{catalog.cars.map((car) => { const tag = badge(car); return <article className="home-result-card" key={car.id}><Link href={`/catalog/${car.id}`} className="home-result-photo"><Image src={car.images[0]} alt={`${car.brand} ${car.model}`} fill sizes="(max-width: 700px) 50vw, (max-width: 1100px) 33vw, 25vw" /><span className={`result-history-badge ${tag.tone}`}>{tag.label}</span></Link><div><p>{car.location} · Encar</p><h3>{car.brand} {car.model}</h3><small>{car.year} · {distance.format(car.mileage)} км<br />{car.engine} · {car.fuel} · {car.drive}</small><footer><strong>{price(car)}</strong><Link href={`/catalog/${car.id}`}>Подробнее <ArrowRight size={15} /></Link></footer></div></article>; })}</div> : <div className="catalog-preview-empty">По этим параметрам объявлений пока нет. Измените фильтры.</div>}
    <div className="premium-catalog-footer"><button className="premium-button primary" type="button" onClick={() => navigate(true)}>Смотреть весь каталог <ArrowRight size={17} /></button></div>
  </section>;
}
