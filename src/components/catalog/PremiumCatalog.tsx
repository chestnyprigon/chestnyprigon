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
import { CATALOG_MAX_MILEAGE_KM, CATALOG_MAX_PRICE_USD, catalogYearFrom, catalogYearTo } from "@/lib/catalog/catalog-rules";
import { formatUsdWithByn } from "@/lib/pricing/display";

const fuels: Array<"Все" | CarFuel> = ["Все", "Бензин", "Дизель", "Гибрид", "Газ"];
const transmissions = ["Все", "Автомат", "Механика", "Вариатор"] as const;
const drives = ["Все", "Полный", "Передний", "Задний", "2WD"] as const;
const bodyTypes = ["Все", "SUV", "RV", "Минивэн", "Компакт", "Гольф-класс", "Средний класс", "Представительский класс"] as const;
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
  if (car.accidents?.available) return { label: "Без ДТП", tone: "is-clear" };
  return { label: "Нет данных Encar", tone: "is-neutral" };
}

function historyText(car: CatalogCar) {
  const accidents = car.accidents;
  if (accidents?.accidentCount) {
    const payouts = accidents.ownAccidentCostKrw + accidents.otherAccidentCostKrw;
    return `Страховые случаи: ${accidents.accidentCount} · выплаты ${distance.format(payouts)} ₩`;
  }
  if (accidents?.available) return "Без ДТП по отчёту Encar · страховых выплат нет";
  return "Нет данных по страховым случаям";
}

function catalogPrice(car: CatalogCar) {
  return car.calculation.calculationAvailable ? formatUsdWithByn(car.price, car.calculation.rates) : "Расчёт уточняется";
}

export function PremiumCatalog({ catalog, initialSearch }: { catalog: CatalogPage; initialSearch: CatalogSearch }) {
  const { cars } = catalog;
  const router = useRouter();
  const [query, setQuery] = useState(initialSearch.query ?? "");
  const [brand, setBrand] = useState(initialSearch.brand ?? "Все");
  const [model, setModel] = useState(initialSearch.model ?? "Все");
  const [trim, setTrim] = useState(initialSearch.trim ?? "Все");
  const [fuel, setFuel] = useState<(typeof fuels)[number]>((initialSearch.fuel as (typeof fuels)[number]) ?? "Все");
  const [yearFrom, setYearFrom] = useState(String(initialSearch.yearFrom ?? catalogYearFrom()));
  const [yearTo, setYearTo] = useState(String(initialSearch.yearTo ?? catalogYearTo()));
  const [minEngine, setMinEngine] = useState(String(initialSearch.minEngine ?? 0));
  const [maxEngine, setMaxEngine] = useState(String(initialSearch.maxEngine ?? 8000));
  const [minPrice, setMinPrice] = useState(String(initialSearch.minPrice ?? 0));
  const [maxPrice, setMaxPrice] = useState(String(initialSearch.maxPrice ?? CATALOG_MAX_PRICE_USD));
  const [minMileage, setMinMileage] = useState(String(initialSearch.minMileage ?? 0));
  const [maxMileage, setMaxMileage] = useState(String(initialSearch.maxMileage ?? CATALOG_MAX_MILEAGE_KM));
  const [transmission, setTransmission] = useState<(typeof transmissions)[number]>((initialSearch.transmission as (typeof transmissions)[number]) ?? "Все");
  const [drive, setDrive] = useState<(typeof drives)[number]>((initialSearch.drive as (typeof drives)[number]) ?? "Все");
  const [bodyType, setBodyType] = useState<(typeof bodyTypes)[number]>((initialSearch.bodyType as (typeof bodyTypes)[number]) ?? "Все");
  const [accidentFilter, setAccidentFilter] = useState<(typeof accidentFilters)[number]>(initialSearch.accidents === "clear" ? "Без ДТП" : initialSearch.accidents === "with" ? "Есть страховые случаи" : "Все");
  const [sort, setSort] = useState(initialSearch.sort ?? "newest");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>(catalog.models);
  const [brandOptions, setBrandOptions] = useState<string[]>(catalog.brands);
  const [trimOptions, setTrimOptions] = useState<string[]>([]);
  const { total: matchingTotal, pending: isCounting } = useCatalogFilterCount({
    q: query.trim(),
    brand: brand === "Все" ? "" : brand,
    model: model === "Все" ? "" : model,
    trim: trim === "Все" ? "" : trim,
    fuel: fuel === "Все" ? "" : fuel,
    yearFrom, yearTo, minEngine, maxEngine, minPrice, maxPrice, minMileage, maxMileage,
    transmission: transmission === "Все" ? "" : transmission,
    drive: drive === "Все" ? "" : drive,
    bodyType: bodyType === "Все" ? "" : bodyType,
    accidents: accidentFilter === "Без ДТП" ? "clear" : accidentFilter === "Есть страховые случаи" ? "with" : "",
  }, catalog.total);
  const models = useMemo(() => ["Все", ...new Set([...modelOptions, ...cars.filter((car) => brand === "Все" || car.brand === brand).map((car) => car.model)])], [brand, cars, modelOptions]);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  useEffect(() => {
    const controller = new AbortController();
    const selectedBrand = brand === "Все" ? "" : brand;
    const selectedModel = model === "Все" ? "" : model;
    const params = new URLSearchParams();
    if (selectedBrand) params.set("brand", selectedBrand);
    if (selectedModel) params.set("model", selectedModel);
    fetch(`/api/catalog/filter-options${params.size ? `?${params.toString()}` : ""}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { brands?: unknown; models?: unknown; trims?: unknown } | null) => {
        if (!selectedBrand && Array.isArray(payload?.brands)) setBrandOptions(payload.brands.filter((item): item is string => typeof item === "string"));
        if (selectedBrand && !selectedModel && Array.isArray(payload?.models)) setModelOptions(payload.models.filter((item): item is string => typeof item === "string"));
        if (selectedBrand && selectedModel && Array.isArray(payload?.trims)) setTrimOptions(payload.trims.filter((item): item is string => typeof item === "string"));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [brand, model]);

  const visible = cars;

  const applySearch = (page = 1, override?: { sort?: "newest" | "price-asc" | "price-desc" }) => {
    const params = new URLSearchParams();
    const add = (key: string, value: string, fallback: string) => { if (value && value !== fallback) params.set(key, value); };
    add("q", query.trim(), ""); add("brand", brand, "Все"); add("model", model, "Все"); add("trim", trim, "Все"); add("fuel", fuel, "Все");
    add("yearFrom", yearFrom, String(catalogYearFrom())); add("yearTo", yearTo, String(catalogYearTo())); add("minEngine", minEngine, "0"); add("maxEngine", maxEngine, "8000"); add("minPrice", minPrice, "0"); add("maxPrice", maxPrice, String(CATALOG_MAX_PRICE_USD)); add("minMileage", minMileage, "0"); add("maxMileage", maxMileage, String(CATALOG_MAX_MILEAGE_KM));
    add("transmission", transmission, "Все"); add("drive", drive, "Все"); add("bodyType", bodyType, "Все"); add("sort", override?.sort ?? sort, "newest");
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
    setTrim("Все");
    setFuel("Все");
    setYearFrom(String(catalogYearFrom()));
    setYearTo(String(catalogYearTo()));
    setMinEngine("0");
    setMaxEngine("8000");
    setMinPrice("0");
    setMaxPrice(String(CATALOG_MAX_PRICE_USD));
    setMinMileage("0");
    setMaxMileage(String(CATALOG_MAX_MILEAGE_KM));
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
          <fieldset><legend>Марка</legend><div className="filter-pills">{["Все", ...brandOptions].map((item) => <button className={brand === item ? "is-selected" : ""} type="button" key={item} onClick={() => { setBrand(item); setModel("Все"); setTrim("Все"); setModelOptions([]); setTrimOptions([]); }}>{item}</button>)}</div></fieldset>
          {brand !== "Все" ? <label className="filter-select"><span>Модель</span><select value={model} onChange={(event) => { setModel(event.target.value); setTrim("Все"); setTrimOptions([]); }}><option value="Все">Все модели</option>{models.filter((item) => item !== "Все").map((item) => <option key={item} value={item}>{item}</option>)}</select></label> : null}
          {brand !== "Все" && model !== "Все" ? <label className="filter-select"><span>Комплектация</span><select value={trim} onChange={(event) => setTrim(event.target.value)}><option value="Все">Все комплектации</option>{trimOptions.map((item) => <option key={item} value={item}>{item}</option>)}</select></label> : null}
          <div className="filter-pair"><label className="filter-select"><span>Год от</span><select value={yearFrom} onChange={(event) => setYearFrom(event.target.value)}>{YEAR_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label className="filter-select"><span>до</span><select value={yearTo} onChange={(event) => setYearTo(event.target.value)}>{YEAR_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label></div>
          <div className="filter-pair"><label className="filter-select"><span>Объём от</span><select value={minEngine} onChange={(event) => setMinEngine(event.target.value)}><option value="0">Любой</option>{ENGINE_MIN_OPTIONS.filter(Boolean).map((item) => <option key={item} value={item}>{(item / 1_000).toFixed(1)} л</option>)}</select></label><label className="filter-select"><span>до</span><select value={maxEngine} onChange={(event) => setMaxEngine(event.target.value)}>{ENGINE_MAX_OPTIONS.map((item) => <option key={item} value={item}>{item === 8_000 ? "Любой" : `${(item / 1_000).toFixed(1)} л`}</option>)}</select></label></div>
          <div className="filter-pair"><label className="filter-select"><span>Цена от</span><select value={minPrice} onChange={(event) => setMinPrice(event.target.value)}><option value="0">Любая</option>{PRICE_MIN_OPTIONS.filter(Boolean).map((item) => <option key={item} value={item}>{money.format(item)}</option>)}</select></label><label className="filter-select"><span>до</span><select value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)}>{PRICE_MAX_OPTIONS.map((item) => <option key={item} value={item}>{item === CATALOG_MAX_PRICE_USD ? "Любая" : money.format(item)}</option>)}</select></label></div>
          <div className="filter-pair"><label className="filter-select"><span>Пробег от</span><select value={minMileage} onChange={(event) => setMinMileage(event.target.value)}><option value="0">Любой</option>{MILEAGE_MIN_OPTIONS.filter(Boolean).map((item) => <option key={item} value={item}>{distance.format(item)} км</option>)}</select></label><label className="filter-select"><span>до</span><select value={maxMileage} onChange={(event) => setMaxMileage(event.target.value)}>{MILEAGE_MAX_OPTIONS.map((item) => <option key={item} value={item}>{distance.format(item)} км</option>)}</select></label></div>
          <fieldset><legend>Тип двигателя</legend><div className="filter-pills">{fuels.map((item) => <button className={fuel === item ? "is-selected" : ""} type="button" key={item} onClick={() => setFuel(item)}>{item}</button>)}</div></fieldset>
          <fieldset><legend>Коробка передач</legend><div className="filter-pills">{transmissions.map((item) => <button className={transmission === item ? "is-selected" : ""} type="button" key={item} onClick={() => setTransmission(item)}>{item}</button>)}</div></fieldset>
          <fieldset><legend>Привод</legend><div className="filter-pills">{drives.map((item) => <button className={drive === item ? "is-selected" : ""} type="button" key={item} onClick={() => setDrive(item)}>{item}</button>)}</div></fieldset>
          <fieldset><legend>Кузов</legend><div className="filter-pills">{bodyTypes.map((item) => <button className={bodyType === item ? "is-selected" : ""} type="button" key={item} onClick={() => setBodyType(item)}>{item}</button>)}</div></fieldset>
          <fieldset><legend>История Encar</legend><div className="filter-pills">{accidentFilters.map((item) => <button className={accidentFilter === item ? "is-selected" : ""} type="button" key={item} onClick={() => setAccidentFilter(item)}>{item}</button>)}</div></fieldset>
          <button className="apply-filters" type="button" onClick={() => applySearch()}>{isCounting ? "Подсчитываем…" : `Показать ${matchingTotal} авто`} <ArrowRight size={16} /></button>
        </aside>

        <div className="catalog-results">
          <div className="results-toolbar"><div><strong>{catalog.total} автомобилей</strong><span>Показано {visible.length} из {catalog.total} · Encar · проверка перед публикацией</span></div><label>Сортировка<select value={sort} onChange={(event) => { const nextSort = event.target.value as "newest" | "price-asc" | "price-desc"; setSort(nextSort); applySearch(1, { sort: nextSort }); }}><option value="newest">Сначала новые</option><option value="price-asc">Сначала дешевле</option><option value="price-desc">Сначала дороже</option></select></label></div>
          {visible.length ? <div className="catalog-result-grid">{visible.map((car) => { const badge = historyBadge(car); return <article className="result-car" key={car.id}>
            <Link className="result-car-media" href={`/catalog/${car.id}`}><Image src={car.images[0]} alt={`${car.brand} ${car.model}`} fill unoptimized={car.images[0].startsWith("https://ci.encar.com/")} sizes="(max-width: 760px) 100vw, 33vw" /><span className={`result-history-badge ${badge.tone}`}>{badge.label}</span></Link>
            <div className="result-car-body"><p><span className={`card-history-meta ${badge.tone}`}>{historyText(car)}</span><small className="listing-freshness">{freshnessDate(car)}</small></p><h2>{car.brand} {car.model}</h2><h3>{car.trim}</h3><div className="result-specs"><span><CarFront />{car.year}</span><span><Gauge />{distance.format(car.mileage)} км</span><span>{car.engine}</span><span>{car.fuel}</span><span>{car.drive}</span></div><footer><div><strong>{catalogPrice(car)}</strong><small>{car.calculation.calculationAvailable ? "под ключ в Минске" : car.calculation.unavailableReason}</small></div></footer></div>
          </article>; })}</div> : <div className="catalog-no-results"><Search /><h2>Подходящих автомобилей не найдено</h2><p>Измените параметры или сбросьте фильтры.</p><button type="button" onClick={reset}>Сбросить фильтры</button></div>}
          {visible.length > 0 && (catalog.page > 1 || catalog.hasMore) ? <div className="catalog-pagination">{catalog.page > 1 ? <button type="button" onClick={() => applySearch(catalog.page - 1)}><ArrowLeft size={16} />Предыдущие</button> : null}<span>Страница {catalog.page}</span>{catalog.hasMore ? <button type="button" onClick={() => applySearch(catalog.page + 1)}>Следующие {catalog.perPage} авто <ArrowRight size={16} /></button> : null}</div> : null}
        </div>
      </section>

      <section className="catalog-consult"><div><p className="premium-kicker"><span />Не нашли подходящий вариант?</p><h2>Подберём автомобиль<br />под ваш запрос</h2><p>Оставьте критерии — менеджер подготовит персональную подборку.</p></div><Link href="/#contacts">Получить подборку <ArrowRight /></Link></section>
      <footer className="catalog-simple-footer"><Link href="/">ЧЕСТНЫЙ <em>ПРИГОН</em></Link><span>Автомобили из Кореи с доставкой в Беларусь</span><a href="tel:+375447543987">+375 (44) 754-39-87</a></footer>

    </main>
  );
}
