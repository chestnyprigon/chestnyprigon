"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FILTER_FIELDS, RANGE_FIELDS, SORT_OPTIONS, mobileDeFilterParams, parseMobileDeFilters, type FilterErrors, type FilterSearch, type FilterValues } from "@/lib/mobile-de/filters";
import type { MobileDeFacets } from "@/lib/mobile-de/types";
import styles from "./MobileDeCatalog.module.css";

const dictionaryKeys = {make:"makes",model:"models",fuel_type:"fuel_types",transmission:"transmissions",body_type:"body_types"} as const;

export function MobileDeFilterForm({ params, initialErrors }: {params:FilterSearch; initialErrors:FilterErrors}) {
  const router=useRouter();
  const [values,setValues]=useState<FilterValues>(()=>Object.fromEntries(Object.entries(params).filter(([,v])=>typeof v === "string")));
  const [errors,setErrors]=useState(initialErrors);
  const [facets,setFacets]=useState<MobileDeFacets>({});
  const [status,setStatus]=useState<"loading"|"ready"|"error">("loading");
  const [attempt,setAttempt]=useState(0);
  const [pending,startTransition]=useTransition();
  useEffect(()=>{
    const controller=new AbortController();
    fetch("/api/catalog/europe/facets",{signal:controller.signal,cache:"no-store"})
      .then(async response=>{if(!response.ok)throw new Error("Dictionary unavailable");return response.json();})
      .then(payload=>{
        const data=payload?.data;
        if(!data || typeof data!=="object" || Object.values(dictionaryKeys).some(key=>data[key]!==undefined && (!Array.isArray(data[key]) || data[key].some((value:unknown)=>typeof value!=="string")))) throw new Error("Unsupported dictionary format");
        if(!controller.signal.aborted){setFacets(data);setStatus("ready");}
      })
      .catch(()=>{if(!controller.signal.aborted)setStatus("error");});
    return ()=>controller.abort();
  },[attempt]);
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
      const raw=facets[dictionaryKeys[key]];
      const options=Array.isArray(raw)?raw.filter((value):value is string=>typeof value==="string"):[];
      const unique=[...new Set(options)].sort((a,b)=>a.localeCompare(b,"ru"));
      return <label className={styles.field} key={key}><span>{label}</span>
        <select name={key} value={values[key]||""} onChange={event=>update(key,event.target.value)} disabled={status!=="ready" || (key==="model"&&!values.make)} aria-invalid={Boolean(errors[key])} aria-describedby={errors[key]?`error-${key}`:undefined}>
          <option value="">{key==="model"&&!values.make?"Сначала выберите марку":"Любая"}</option>
          {values[key]&&!unique.includes(values[key]!)&&<option value={values[key]}>{values[key]}</option>}
          {unique.map(value=><option key={value} value={value}>{value}</option>)}
        </select>
        {errors[key]&&<small id={`error-${key}`} role="alert">{errors[key]}</small>}
      </label>;
    })}
    <p className={styles.filterFootnote}>Модели показаны из общего справочника. При поиске учитываются и марка, и модель.</p>
    {status==="loading"&&<p className={styles.filterFootnote} role="status">Загружаем справочники. Поиск по числовым параметрам уже доступен.</p>}
    {status==="error"&&<div className={styles.filterFootnote} role="status">Не удалось загрузить марки, модели и другие справочники. Числовые фильтры доступны. <button type="button" onClick={()=>{setStatus("loading");setAttempt(value=>value+1);}}>Повторить загрузку</button></div>}
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
