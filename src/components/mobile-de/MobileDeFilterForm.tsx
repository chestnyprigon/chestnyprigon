"use client";

import { ArrowRight, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SORT_OPTIONS, mobileDeFilterParams, parseMobileDeFilters, type FilterErrors, type FilterSearch, type FilterValues } from "@/lib/mobile-de/filters";
import { mobileDeModelKey, normalizeMobileDeModels } from "@/lib/mobile-de/models";
import { mobileDeMakeKey, normalizeMobileDeMakes } from "@/lib/mobile-de/makes";
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
const engineSizeOptions = [0.8, 1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2, 2.2, 2.5, 3, 3.5, 4, 5, 6, 7, 8].map((litres) => {
  const nominalCc = Math.round(litres * 1000);
  return { litres, minimumCc: nominalCc - 50, maximumCc: nominalCc + 49 };
});

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

export function MobileDeFilterForm({ params, initialErrors }: { params: FilterSearch; initialErrors: FilterErrors }) {
  const router = useRouter();
  const [values, setValues] = useState<FilterValues>(() => Object.fromEntries(Object.entries(params).filter(([, value]) => typeof value === "string")));
  const [errors, setErrors] = useState(initialErrors);
  const [matchingCount, setMatchingCount] = useState<number | null>(null);
  const [countPending, setCountPending] = useState(() => parseMobileDeFilters(params).valid);
  const [pending, startTransition] = useTransition();
  const globalDictionary = useDictionary();
  const facets = globalDictionary.data;
  const makeOptions = useMemo(() => normalizeMobileDeMakes(facets.makes || []), [facets.makes]);
  const selectedMake = makeOptions.find((option) => mobileDeMakeKey(option.value) === mobileDeMakeKey(values.make || ""));
  const selectedMakeValue = selectedMake?.value || values.make?.trim();
  const makeDictionary = useDictionary(selectedMakeValue, Boolean(selectedMakeValue));
  const scoped = makeDictionary.data;
  const registrationYears = useMemo(() => {
    const min = facets.ranges?.registration_year_min;
    const max = facets.ranges?.registration_year_max;
    if (typeof min !== "number" || typeof max !== "number") return [];
    return Array.from({ length: Math.min(80, max - min + 1) }, (_, index) => max - index);
  }, [facets.ranges?.registration_year_min, facets.ranges?.registration_year_max]);

  const modelOptions = useMemo(() => normalizeMobileDeModels(scoped.models || []), [scoped.models]);
  const selectedModel = modelOptions.find((model) => mobileDeModelKey(model) === mobileDeModelKey(values.model || ""));

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
    setErrors(parseMobileDeFilters(nextValues).errors);
    setMatchingCount(null);
    setCountPending(parseMobileDeFilters(nextValues).valid);
  }

  function apply() {
    const normalizedValues = selectedModel ? { ...values, model: selectedModel } : values;
    const parsed = parseMobileDeFilters({ ...normalizedValues, cursor: undefined });
    setErrors(parsed.errors);
    if (!parsed.valid) return;
    if (normalizedValues !== values) setValues(normalizedValues);
    const query = mobileDeFilterParams(parsed.filters);
    startTransition(() => router.push(`/catalog/europe${query.size ? `?${query.toString()}` : ""}`, { scroll: false }));
  }

  const valueOptions = (key: keyof typeof dictionaryKeys) => {
    if (key === "make") return makeOptions.map((option) => option.value);
    if (key === "model") return modelOptions;
    const dictionary = scoped[dictionaryKeys[key]] !== undefined ? scoped : facets;
    const values = dictionary[dictionaryKeys[key]] || [];
    return [...new Set(values)].sort((a, b) => a.localeCompare(b, "ru"));
  };

  const dictionaryState = (key: keyof typeof dictionaryKeys) => key === "make" ? globalDictionary.status : key === "model" || (values.make && scoped[dictionaryKeys[key]] === undefined) ? makeDictionary.status : globalDictionary.status;

  return <form className={styles.filters} onSubmit={(event) => { event.preventDefault(); apply(); }}>
    <div className={styles.filterHeading}>
      <span><SlidersHorizontal size={17} /> Фильтры</span>
      <button type="button" onClick={() => { setValues({}); setErrors({}); setMatchingCount(null); setCountPending(true); startTransition(() => router.push("/catalog/europe", { scroll: false })); }}>Сбросить</button>
    </div>
    <p className={styles.filterFootnote}>В каталоге: {typeof facets.ranges?.count === "number" ? new Intl.NumberFormat("ru-RU").format(facets.ranges.count) : "—"} автомобилей</p>

    <div className={styles.dictionaryGrid}>
      {filterGroups.map(([key, label]) => {
        const options = valueOptions(key);
        const status = dictionaryState(key);
        const disabled = (key === "model" && !values.make) || status === "loading" || status === "error";
        const selectedValue = key === "make" ? selectedMakeValue || "" : key === "model" ? selectedModel || values.model || "" : values[key] || "";
        return <label className={styles.field} key={key}>
          <span>{label}</span>
          <select name={key} value={selectedValue} onChange={(event) => update(key, event.target.value)} disabled={disabled} aria-invalid={Boolean(errors[key])}>
            <option value="">{key === "make" ? "Все марки" : key === "model" ? !values.make ? "Сначала выберите марку" : status === "loading" ? "Загружаем модели…" : "Все модели" : status === "loading" ? "Загружаем варианты…" : "Любое"}</option>
            {selectedValue && !options.includes(selectedValue) && <option value={selectedValue}>{selectedValue}</option>}
            {options.map((option) => <option value={option} key={key === "model" ? mobileDeModelKey(option) : key === "make" ? mobileDeMakeKey(option) : option}>{key === "make" ? makeOptions.find((makeOption) => makeOption.value === option)?.label || option : option}</option>)}
          </select>
          {status === "error" && <small role="status">Список временно недоступен. <button type="button" onClick={key === "model" ? makeDictionary.retry : globalDictionary.retry}>Повторить</button></small>}
          {errors[key] && <small role="alert">{errors[key]}</small>}
        </label>;
      })}
    </div>

    <div className={styles.selectPairs}>
      <div className={styles.rangePair}>{([["registration_year_min", "Регистрация от"], ["registration_year_max", "Регистрация до"]] as const).map(([key, label]) => {
        const options = registrationYears;
        const selected = values[key];
        return <label className={styles.field} key={key}><span>{label}</span><select value={selected || ""} onChange={(event) => update(key, event.target.value)}>
          <option value="">{options.length ? "Любой" : "Нет данных о регистрации"}</option>
          {selected && !options.includes(Number(selected)) && <option value={selected}>{selected}</option>}
          {options.map((year) => <option value={year} key={year}>{year}</option>)}
        </select>{errors[key] && <small role="alert">{errors[key]}</small>}</label>;
      })}</div>
      <div className={styles.rangePair}>{([["engine_cc_min", "Объём от, л"], ["engine_cc_max", "Объём до, л"]] as const).map(([key, label]) => <label className={styles.field} key={key}>
        <span>{label}</span><select value={values[key] || ""} onChange={(event) => update(key, event.target.value)}><option value="">Любой</option>{values[key] && !engineSizeOptions.some((option) => Number(values[key]) === (key === "engine_cc_min" ? option.minimumCc : option.maximumCc)) && <option value={values[key]}>{((Number(values[key]) + (key === "engine_cc_min" ? 50 : -49)) / 1000).toFixed(1)} л</option>}{engineSizeOptions.map((option) => <option value={key === "engine_cc_min" ? option.minimumCc : option.maximumCc} key={option.litres}>{option.litres.toFixed(1)} л</option>)}</select>{errors[key] && <small role="alert">{errors[key]}</small>}
      </label>)}</div>
    </div>
    <div className={styles.rangeGroups}>
      {rangeGroups.map((group) => <div className={styles.rangePair} key={group[0][0]}>{group.map(([key, label]) => <label className={styles.field} key={key}>
        <span>{label}</span>
        <input name={key} type="number" min="0" step={key.startsWith("price_") ? "0.01" : "1"} inputMode="numeric" value={values[key] || ""} onChange={(event) => update(key, event.target.value)} aria-invalid={Boolean(errors[key])} placeholder="Любой" />
        {errors[key] && <small role="alert">{errors[key]}</small>}
      </label>)}</div>)}
    </div>

    <label className={styles.field}><span>Сортировка</span><select name="sort" value={values.sort || "updated_desc"} onChange={(event) => update("sort", event.target.value)}>{SORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{errors.sort && <small role="alert">{errors.sort}</small>}</label>
    {globalDictionary.status === "error" && <p className={styles.filterFootnote}>Не удалось получить марки. Повторите загрузку справочника или введите точную марку в поиск.</p>}
    <button className={styles.submit} type="submit" disabled={pending}>
      {pending ? "Загружаем…" : countPending ? "Считаем автомобили…" : matchingCount === null ? "Показать автомобили" : `Показать ${new Intl.NumberFormat("ru-RU").format(matchingCount)} авто`}<ArrowRight size={18} />
    </button>
  </form>;
}
