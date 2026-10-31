import type { MobileDeFilters } from "./types";
export const SORT_OPTIONS = [
  ["updated_desc", "Сначала новые в базе"], ["price_asc", "Сначала дешевле"], ["price_desc", "Сначала дороже"],
  ["year_desc", "Сначала новее по году выпуска"], ["year_asc", "Сначала старше по году выпуска"],
  ["mileage_asc", "Сначала с меньшим пробегом"], ["mileage_desc", "Сначала с большим пробегом"], ["updated_asc", "Сначала давно обновлённые"],
] as const;
export const FILTER_FIELDS = [["make","Марка"],["model","Модель"],["fuel_type","Топливо"],["transmission","Коробка передач"],["body_type","Кузов"]] as const;
export const RANGE_FIELDS = [
  ["price_min","Цена от, €",0,1_000_000_000],["price_max","Цена до, €",0,1_000_000_000],
  ["year_min","Год выпуска от",1886,2100],["year_max","Год выпуска до",1886,2100],
  ["registration_year_min","Первая регистрация от",1886,2100],["registration_year_max","Первая регистрация до",1886,2100],
  ["mileage_min","Пробег от, км",0,10_000_000],["mileage_max","Пробег до, км",0,10_000_000],
  ["power_min","Мощность от, л. с.",0,5000],["power_max","Мощность до, л. с.",0,5000],
] as const;
export type FilterValues = Partial<Record<keyof MobileDeFilters,string>>;
export type FilterErrors = Partial<Record<keyof MobileDeFilters,string>>;
export type FilterSearch = Record<string,string|string[]|undefined>;
export function parseMobileDeFilters(search: FilterSearch) {
  const filters: MobileDeFilters = {limit:"20",sort:"updated_desc"};
  const errors: FilterErrors = {};
  const read=(key:keyof MobileDeFilters)=>{
    const value=search[key];
    if(Array.isArray(value)){errors[key]="Параметр должен быть указан один раз";return "";}
    return value?.trim() || "";
  };
  for(const [key] of FILTER_FIELDS){const value=read(key);if(value){if(value.length>120||/[\x00-\x1f]/.test(value))errors[key]="Некорректное значение";else filters[key]=value;}}
  if(filters.model&&!filters.make)errors.model="Сначала выберите марку";
  for(const [key,label,min,max] of RANGE_FIELDS){
    const raw=read(key);if(!raw)continue;
    const value=key.startsWith("price_")?raw.replace(",","."):raw;
    const valid=key.startsWith("price_")?/^\d+(?:\.\d{1,2})?$/.test(value):/^\d+$/.test(value);
    if(!valid||!Number.isFinite(Number(value))||Number(value)<min||Number(value)>max){errors[key]=`${label}: укажите ${key.startsWith("price_")?"число":"целое число"} от ${min} до ${max}`;continue;}
    filters[key]=String(Number(value));
  }
  for(const prefix of ["price","year","registration_year","mileage","power"] as const){
    const from=`${prefix}_min` as keyof MobileDeFilters,to=`${prefix}_max` as keyof MobileDeFilters;
    if(filters[from]!==undefined&&filters[to]!==undefined&&Number(filters[from])>Number(filters[to])){errors[from]="Значение «от» не должно превышать «до»";errors[to]="Значение «до» не должно быть меньше «от»";}
  }
  const sort=read("sort");if(sort){if(SORT_OPTIONS.some(([value])=>value===sort))filters.sort=sort;else errors.sort="Выберите доступную сортировку";}
  const cursor=read("cursor");if(cursor){if(cursor.length>8192)errors.cursor="Некорректная ссылка на страницу";else filters.cursor=cursor;}
  return {filters,errors,valid:Object.keys(errors).length===0};
}
export function mobileDeFilterParams(filters: MobileDeFilters, cursor?: string) {
  const params=new URLSearchParams();
  for(const [key] of [...FILTER_FIELDS,...RANGE_FIELDS]){const value=filters[key];if(value!==undefined&&value!=="")params.set(key,value);}
  if(filters.sort&&filters.sort!=="updated_desc")params.set("sort",filters.sort);
  if(cursor)params.set("cursor",cursor);
  return params;
}
