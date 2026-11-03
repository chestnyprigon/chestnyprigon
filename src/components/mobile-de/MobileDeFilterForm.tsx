"use client";

import { ArrowRight, Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SORT_OPTIONS, mobileDeFilterParams, parseMobileDeFilters, type FilterErrors, type FilterSearch, type FilterValues } from "@/lib/mobile-de/filters";
import type { MobileDeFacets } from "@/lib/mobile-de/types";
import styles from "./MobileDeCatalog.module.css";

const dictionaryKeys = { make: "makes", model: "models", fuel_type: "fuel_types", transmission: "transmissions", body_type: "body_types" } as const;
const filterGroups = [
  ["make", "Марка"], ["model", "Модель"], ["fuel_type", "Топливо"], ["transmission", "Коробка передач"], ["body_type", "Кузов"],
] as const;
const rangeGroups = [
  [["price_min", "Цена от, €"], ["price_max", "Цена до, €"]],
  [["mileage_min", "Пробег от, км"], ["mileage_max", "Пробег до, км"]],
  [["power_min", "Мощность от, л. с."], ["power_max", "Мощность до, л. с."]],
] as const;
const engineSizeOptions = [800, 1000, 1200, 1300, 1400, 1500, 1600, 1800, 2000, 2200, 2500, 3000, 3500, 4000, 5000, 6000, 7000, 8000];

type DictionaryState = { key: string; data: MobileDeFacets; status: "ready" | "error" };

function useDictionary(make?: string, enabled = true) {
  const key = make || "";
  const [result, setResult] = useState<DictionaryState | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      if (make) params.set("make", make);
      fetch(`/api/catalog/europe/facets?${params}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error("Dictionary unavailable");
          return response.json();
        })
        .then((payload) => {
          if (!payload?.data || typeof payload.data !== "object") throw new Error("Invalid dictionary");
          if (!controller.signal.aborted) setResult({ key, data: payload.data, status: "ready" });
        })
        .catch(() => {
          if (!controller.signal.aborted) setResult({ key, data: {}, status: "error" });
        });
    }, make ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, make, enabled, attempt]);
  const current = enabled && result?.key === key ? result : null;
  return {
    data: current?.data || {},
    status: enabled ? current?.status || "loading" : "idle",
    retry: () => { setResult(null); setAttempt((value) => value + 1); },
  };
}

function yearOptions(minimum: unknown, maximum: unknown) {
  if (typeof minimum !== "number" || typeof maximum !== "number") return [];
  const min = minimum;
  const max = maximum;
  const start = Math.max(1886, Math.min(min, max));
  const end = Math.max(min, max);
  return Array.from({ length: Math.min(80, end - start + 1) }, (_, index) => end - index);
}

export function MobileDeFilterForm({ params, initialErrors }: { params: FilterSearch; initialErrors: FilterErrors }) {
  const router = useRouter();
  const [values, setValues] = useState<FilterValues>(() => Object.fromEntries(Object.entries(params).filter(([, value]) => typeof value === "string")));
  const [errors, setErrors] = useState(initialErrors);
  const [makeSearch, setMakeSearch] = useState("");
  const [matchingCount, setMatchingCount] = useState<number | null>(null);
  const [countPending, setCountPending] = useState(() => parseMobileDeFilters(params).valid);
  const [pending, startTransition] = useTransition();
  const globalDictionary = useDictionary();
  const makeDictionary = useDictionary(values.make?.trim(), Boolean(values.make?.trim()));
  const facets = globalDictionary.data;
  const scoped = makeDictionary.data;
  const productionYears = useMemo(() => yearOptions(facets.ranges?.year_min, facets.ranges?.year_max), [facets.ranges?.year_min, facets.ranges?.year_max]);
  const registrationYears = useMemo(() => yearOptions(facets.ranges?.registration_year_min, facets.ranges?.registration_year_max), [facets.ranges?.registration_year_min, facets.ranges?.registration_year_max]);
  const yearGroups = [
    { keys: ["year_min", "year_max"] as const, labels: ["Год выпуска от", "Год выпуска до"] as const, years: productionYears },
    { keys: ["registration_year_min", "registration_year_max"] as const, labels: ["Регистрация от", "Регистрация до"] as const, years: registrationYears },
  ];

  const makeOptions = useMemo(() => [...new Set(facets.makes || [])].sort((a, b) => a.localeCompare(b, "ru")), [facets.makes]);
  const visibleMakes = useMemo(() => makeOptions.filter((make) => make.toLocaleLowerCase("ru").includes(makeSearch.trim().toLocaleLowerCase("ru"))), [makeOptions, makeSearch]);

  useEffect(() => {
    const controller = new AbortController();
    const parsed = parseMobileDeFilters({ ...values, cursor: undefined });
    if (!parsed.valid) return () => controller.abort();
    const query = mobileDeFilterParams(parsed.filters);
    const timer = setTimeout(() => {
      fetch(`/api/catalog/europe/count${query.size ? `?${query.toString()}` : ""}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error("Count unavailable");
          return response.json();
        })
        .then((payload: { count?: unknown }) => {
          if (!controller.signal.aborted && typeof payload.count === "number") setMatchingCount(payload.count);
        })
        .catch(() => { if (!controller.signal.aborted) setMatchingCount(null); })
        .finally(() => { if (!controller.signal.aborted) setCountPending(false); });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [values]);

  function update(key: keyof FilterValues, value: string) {
    const nextValues = { ...values, [key]: value, ...(key === "make" ? { model: "" } : {}) };
    setValues(nextValues);
    setErrors((current) => ({ ...current, [key]: undefined, ...(key === "make" ? { model: undefined } : {}) }));
    setMatchingCount(null);
    setCountPending(parseMobileDeFilters(nextValues).valid);
  }

  function apply() {
    const parsed = parseMobileDeFilters({ ...values, cursor: undefined });
    setErrors(parsed.errors);
    if (!parsed.valid) return;
    const query = mobileDeFilterParams(parsed.filters);
    startTransition(() => router.push(`/catalog/europe${query.size ? `?${query.toString()}` : ""}`, { scroll: false }));
  }

  const valueOptions = (key: keyof typeof dictionaryKeys) => {
    const dictionary = key === "make" ? facets : key === "model" ? scoped : (scoped[dictionaryKeys[key]] !== undefined ? scoped : facets);
    const values = dictionary[dictionaryKeys[key]] || [];
    return [...new Set(values)].sort((a, b) => a.localeCompare(b, "ru"));
  };

  return <form className={styles.filters} onSubmit={(event) => { event.preventDefault(); apply(); }}>
    <div className={styles.filterHeading}>
      <span><SlidersHorizontal size={17} /> Фильтры</span>
      <button type="button" onClick={() => { setValues({}); setErrors({}); setMakeSearch(""); setMatchingCount(null); setCountPending(true); startTransition(() => router.push("/catalog/europe", { scroll: false })); }}>Сбросить</button>
    </div>
    <p className={styles.filterFootnote}>В каталоге: {typeof facets.ranges?.count === "number" ? new Intl.NumberFormat("ru-RU").format(facets.ranges.count) : "—"} автомобилей</p>

    <label className={`${styles.field} ${styles.makeSearch}`}>
      <span>Поиск марки</span>
      <span className={styles.searchInput}><Search size={17} /><input value={makeSearch} onChange={(event) => { const value = event.target.value; setMakeSearch(value); const exact = makeOptions.find((make) => make.toLocaleLowerCase("ru") === value.trim().toLocaleLowerCase("ru")); if (exact) update("make", exact); }} placeholder="Марка автомобиля" autoComplete="off" /></span>
    </label>
    <fieldset className={styles.pillGroup}>
      <legend>Марка</legend>
      <div className={styles.pills}>
        <button type="button" className={!values.make ? styles.selectedPill : ""} aria-pressed={!values.make} onClick={() => update("make", "")}>Все</button>
        {visibleMakes.map((make) => <button type="button" key={make} className={values.make === make ? styles.selectedPill : ""} aria-pressed={values.make === make} onClick={() => update("make", make)}>{make}</button>)}
        {makeSearch.trim() && !makeOptions.some((make) => make.toLocaleLowerCase("ru") === makeSearch.trim().toLocaleLowerCase("ru")) && <button type="button" onClick={() => update("make", makeSearch.trim())}>Использовать «{makeSearch.trim()}»</button>}
        {values.make && !makeOptions.includes(values.make) && <button type="button" className={styles.selectedPill} onClick={() => update("make", values.make!)}>{values.make}</button>}
      </div>
      {errors.make && <small role="alert">{errors.make}</small>}
    </fieldset>

    <label className={styles.field}>
      <span>Модель</span>
      <select name="model" value={values.model || ""} onChange={(event) => update("model", event.target.value)} disabled={!values.make || makeDictionary.status !== "ready"} aria-invalid={Boolean(errors.model)}>
        <option value="">{!values.make ? "Сначала выберите марку" : makeDictionary.status === "loading" ? "Загружаем модели…" : "Все модели"}</option>
        {values.model && !valueOptions("model").includes(values.model) && <option value={values.model}>{values.model}</option>}
        {valueOptions("model").map((model) => <option value={model} key={model}>{model}</option>)}
      </select>
      {errors.model && <small role="alert">{errors.model}</small>}
    </label>

    <div className={styles.dictionaryGrid}>
      {filterGroups.filter(([key]) => key !== "make" && key !== "model").map(([key, label]) => {
        const options = valueOptions(key);
        const loading = key === "model" ? makeDictionary.status === "loading" : globalDictionary.status === "loading";
        const unavailable = key === "model" ? makeDictionary.status === "error" : globalDictionary.status === "error";
        return <fieldset className={styles.pillGroup} key={key}>
          <legend>{label}</legend>
          <div className={styles.pills}>
            <button type="button" className={!values[key] ? styles.selectedPill : ""} aria-pressed={!values[key]} onClick={() => update(key, "")} disabled={key === "model" && !values.make}>{key === "model" && !values.make ? "Сначала марка" : "Любая"}</button>
            {options.map((option) => <button type="button" key={option} className={values[key] === option ? styles.selectedPill : ""} aria-pressed={values[key] === option} onClick={() => update(key, option)} disabled={key === "model" && !values.make}>{option}</button>)}
          </div>
          {loading && <small role="status">Загружаем варианты…</small>}
          {unavailable && <small role="status">Список временно недоступен. <button type="button" onClick={key === "model" ? makeDictionary.retry : globalDictionary.retry}>Повторить</button></small>}
          {errors[key] && <small role="alert">{errors[key]}</small>}
        </fieldset>;
      })}
    </div>

    <div className={styles.selectPairs}>
      {yearGroups.map((group) => <div className={styles.rangePair} key={group.keys[0]}>{group.keys.map((key, index) => {
        const options = group.years;
        const selected = values[key];
        return <label className={styles.field} key={key}><span>{group.labels[index]}</span><select value={selected || ""} onChange={(event) => update(key, event.target.value)}>
          <option value="">{options.length ? "Любой" : key.startsWith("registration_") ? "Нет данных о регистрации" : "Нет данных о годе"}</option>
          {selected && !options.includes(Number(selected)) && <option value={selected}>{selected}</option>}
          {options.map((year) => <option value={year} key={year}>{year}</option>)}
        </select>{errors[key] && <small role="alert">{errors[key]}</small>}</label>;
      })}</div>)}
      <div className={styles.rangePair}>{([["engine_cc_min", "Объём от, л"], ["engine_cc_max", "Объём до, л"]] as const).map(([key, label]) => <label className={styles.field} key={key}>
        <span>{label}</span><select value={values[key] || ""} onChange={(event) => update(key, event.target.value)}><option value="">Любой</option>{values[key] && !engineSizeOptions.includes(Number(values[key])) && <option value={values[key]}>{(Number(values[key]) / 1000).toFixed(1)} л</option>}{engineSizeOptions.map((cc) => <option value={cc} key={cc}>{(cc / 1000).toFixed(1)} л</option>)}</select>{errors[key] && <small role="alert">{errors[key]}</small>}
      </label>)}</div>
    </div>
    {!productionYears.length && <p className={styles.filterFootnote} role="status">Год выпуска пока не заполнен в объявлениях. Для отбора используйте отдельный фильтр первой регистрации.</p>}

    <div className={styles.rangeGroups}>
      {rangeGroups.map((group) => <div className={styles.rangePair} key={group[0][0]}>{group.map(([key, label]) => <label className={styles.field} key={key}>
        <span>{label}</span>
        <input name={key} type="number" min="0" inputMode="numeric" value={values[key] || ""} onChange={(event) => update(key, event.target.value)} aria-invalid={Boolean(errors[key])} placeholder="Любой" />
        {errors[key] && <small role="alert">{errors[key]}</small>}
      </label>)}</div>)}
    </div>

    <label className={styles.field}><span>Сортировка</span><select name="sort" value={values.sort || "updated_desc"} onChange={(event) => update("sort", event.target.value)}>{SORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{errors.sort && <small role="alert">{errors.sort}</small>}</label>
    {globalDictionary.status === "error" && <p className={styles.filterFootnote}>Не удалось получить марки. Повторите загрузку справочника или введите точную марку в поиск.</p>}
    <button className={styles.submit} type="submit" disabled={pending || Object.keys(errors).length > 0}>
      {pending ? "Загружаем…" : countPending ? "Считаем автомобили…" : matchingCount === null ? "Показать автомобили" : `Показать ${new Intl.NumberFormat("ru-RU").format(matchingCount)} авто`}<ArrowRight size={18} />
    </button>
    <p className={styles.filterFootnote}>Год выпуска и первая регистрация — разные фильтры. Цена указана в евро без доставки и таможни.</p>
  </form>;
}
