"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FILTER_FIELDS, RANGE_FIELDS, SORT_OPTIONS, mobileDeFilterParams, parseMobileDeFilters, type FilterErrors, type FilterSearch, type FilterValues } from "@/lib/mobile-de/filters";
import type { MobileDeFacets } from "@/lib/mobile-de/types";
import styles from "./MobileDeCatalog.module.css";

const dictionaryKeys = {make:"makes",model:"models",fuel_type:"fuel_types",transmission:"transmissions",body_type:"body_types"} as const;

type DictionaryState = { key: string; data: MobileDeFacets; status: "ready" | "error" };

function useDictionary(make?: string, enabled = true) {
  const key = make || "";
  const [result, setResult] = useState<DictionaryState | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    // Typing a make must not send a request for every character.
    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      if (make) params.set("make", make);
      fetch(`/api/catalog/europe/facets?${params}`, {signal:controller.signal, cache:"no-store"})
        .then(async response => {
          if (!response.ok) throw new Error("Dictionary unavailable");
          return response.json();
        })
        .then(payload => {
          if (!payload?.data || typeof payload.data !== "object") throw new Error("Invalid dictionary");
          if (!controller.signal.aborted) setResult({key, data:payload.data, status:"ready"});
        })
        .catch(() => {
          if (!controller.signal.aborted) setResult({key, data:{}, status:"error"});
        });
    }, make ? 500 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, make, enabled, attempt]);
  const current = enabled && result?.key === key ? result : null;
  return {
    data:current?.data || {},
    status: enabled ? current?.status || "loading" : "idle",
    retry: () => { setResult(null); setAttempt(value => value + 1); },
  };
}

export function MobileDeFilterForm({ params, initialErrors }: {params:FilterSearch; initialErrors:FilterErrors}) {
  const router=useRouter();
  const [values,setValues]=useState<FilterValues>(()=>Object.fromEntries(Object.entries(params).filter(([,v])=>typeof v === "string")));
  const [errors,setErrors]=useState(initialErrors);
  const globalDictionary = useDictionary();
  const makeDictionary = useDictionary(values.make?.trim(), Boolean(values.make?.trim()));
  const [pending,startTransition]=useTransition();
  const facets = globalDictionary.data;
  const scoped = makeDictionary.data;
  function update(key:keyof FilterValues,value:string) {
    setValues(current=>({...current,[key]:value,...(key==="make"?{model:""}:{})}));
    setErrors(current=>({...current,[key]:undefined,...(key==="make"?{model:undefined}:{})}));
  }
  return <form className={styles.filters} action="/catalog/europe" onSubmit={event=>{
    event.preventDefault();
    const parsed=parseMobileDeFilters({...values,cursor:undefined});
    setErrors(parsed.errors);
    if(!parsed.valid)return;
    startTransition(()=>router.push(`/catalog/europe?${mobileDeFilterParams(parsed.filters)}`,{scroll:false}));
  }}>
    <div className={styles.filterHeading}><span>Параметры поиска</span><button type="button" onClick={()=>{setValues({});setErrors({});startTransition(()=>router.push("/catalog/europe",{scroll:false}));}}>Сбросить</button></div>
    {typeof facets.ranges?.count==="number" && <p className={styles.filterFootnote}>Всего в каталоге: {new Intl.NumberFormat("ru-RU").format(facets.ranges.count)} авто</p>}
    {FILTER_FIELDS.map(([key,label])=>{
      const dictionary = key === "model" ? scoped : (scoped[dictionaryKeys[key]] !== undefined ? scoped : facets);
      const options = dictionary[dictionaryKeys[key]] || [];
      const unique = [...new Set(options)].sort((a,b)=>a.localeCompare(b,"ru"));
      const status = key === "model" ? makeDictionary.status : globalDictionary.status;
      return <label className={styles.field} key={key}><span>{label}</span>
        {key === "make" ? <>
          <input name="make" list="europe-makes" autoComplete="off" value={values.make || ""} placeholder="Все марки" onChange={event=>update("make",event.target.value)} aria-invalid={Boolean(errors.make)} aria-describedby="europe-make-help" />
          <datalist id="europe-makes">{(facets.makes || []).map(value=><option key={value} value={value} />)}</datalist>
        </> : <select name={key} value={values[key]||""} onChange={event=>update(key,event.target.value)} disabled={key === "model" ? makeDictionary.status !== "ready" : dictionary[dictionaryKeys[key]] === undefined} aria-invalid={Boolean(errors[key])} aria-describedby={errors[key]?`error-${key}`:undefined}>
          <option value="">{key==="model"&&!values.make?"Сначала выберите марку":status==="loading" && key==="model"?"Загружаем модели…":"Любая"}</option>
          {values[key]&&!unique.includes(values[key]!)&&<option value={values[key]}>{values[key]}</option>}
          {unique.map(value=><option key={value} value={value}>{value}</option>)}
        </select>}
        {errors[key]&&<small id={`error-${key}`} role="alert">{errors[key]}</small>}
      </label>;
    })}
    {globalDictionary.status === "loading" && <p id="europe-make-help" className={styles.filterFootnote} role="status">Загружаем список марок. Можно ввести точное название, например BMW.</p>}
    {globalDictionary.status === "error" && <div id="europe-make-help" className={styles.filterFootnote} role="status">Общий справочник временно недоступен. Введите точное название марки — её модели загрузятся отдельно. <button type="button" onClick={globalDictionary.retry}>Повторить загрузку справочника</button></div>}
    {makeDictionary.status === "loading" && <p className={styles.filterFootnote} role="status">Загружаем модели выбранной марки…</p>}
    {makeDictionary.status === "error" && <div className={styles.filterFootnote} role="status">Не удалось загрузить модели марки «{values.make}». Проверьте её написание. <button type="button" onClick={makeDictionary.retry}>Повторить загрузку моделей</button></div>}
    {makeDictionary.status === "ready" && scoped.models?.length === 0 && <p className={styles.filterFootnote}>Для этой марки модели не найдены. Проверьте точное написание марки.</p>}
    {globalDictionary.status === "error" && <p className={styles.filterFootnote}>Поля без справочника временно недоступны. Числовые фильтры работают.</p>}
    <div className={styles.rangeGrid}>{RANGE_FIELDS.map(([key,label])=><label className={styles.field} key={key}><span>{label}</span>
      <input name={key} type="text" inputMode={key.startsWith("price_")?"decimal":"numeric"} value={values[key]||""} onChange={event=>update(key,event.target.value)} aria-invalid={Boolean(errors[key])} aria-describedby={errors[key]?`error-${key}`:undefined} />
      {errors[key]&&<small id={`error-${key}`} role="alert">{errors[key]}</small>}
    </label>)}</div>
    <label className={styles.field}><span>Сортировка</span><select name="sort" value={values.sort||"updated_desc"} onChange={event=>update("sort",event.target.value)}>{SORT_OPTIONS.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>{errors.sort&&<small role="alert">{errors.sort}</small>}</label>
    {errors.cursor&&<p role="alert">{errors.cursor}. Повторите поиск с первой страницы.</p>}
    <button className={styles.submit} type="submit" disabled={pending}>{pending?"Загружаем объявления…":"Показать объявления"}</button>
    <p className={styles.filterFootnote}>Год выпуска и первая регистрация фильтруются отдельно. Цена указана в евро без доставки и таможни.</p>
  </form>;
}
