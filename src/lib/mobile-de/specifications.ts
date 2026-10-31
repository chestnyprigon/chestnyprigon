import type { MobileDeListing } from "./types";

const number = (value: number) => new Intl.NumberFormat("ru-RU").format(value);
const numeric = (text: string, engine: boolean) => {
  const match = text.match(/\d[\d\s.,]*/);
  if (!match) return null;
  const raw = match[0].trim();
  if (engine && /\sл(?:\.|$|\s|итр)/i.test(text)) {
    const litres = Number(raw.replace(",", "."));
    return Number.isFinite(litres) && litres > 0 ? Math.round(litres * 1000) : null;
  }
  if (!/^\d+$/.test(raw) && !/^\d{1,3}(?:[\s.,]\d{3})+$/.test(raw)) return null;
  const value = Number(raw.replace(/[\s.,]/g, ""));
  return Number.isFinite(value) ? value : null;
};
const known = (value: string | null | undefined) => value && !/^(не указан[ао]?|неизвестно|unknown|n\/a|-)$/i.test(value.trim()) ? value : null;

/** Only explicit seller statements fill gaps; structured API fields always win. */
export function mobileDeSpecifications(listing: MobileDeListing): Array<[string, string]> {
  const parsed = new Map<string, string>();
  const aliases: Record<string, string> = {
    "год выпуска": "Год выпуска", "первая регистрация": "Первая регистрация", "пробег": "Пробег",
    "объём двигателя": "Объём двигателя", "объем двигателя": "Объём двигателя", "мощность": "Мощность",
    "топливо": "Топливо", "тип топлива": "Топливо", "коробка передач": "Коробка передач", "привод": "Привод",
    "кузов": "Кузов", "тип кузова": "Кузов", "цвет": "Цвет", "количество дверей": "Количество дверей",
    "количество мест": "Количество мест", "количество владельцев": "Количество владельцев", "техосмотр": "Техосмотр",
  };
  for (const raw of (listing.description ?? "").split(/\r?\n/)) {
    const line = raw.replace(/^[\s•–-]+/, "").trim();
    if (!line || /^по (?:заявлению|словам) продавца:?$/i.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon > 0) {
      const label = aliases[line.slice(0, colon).trim().toLowerCase()];
      const value = known(line.slice(colon + 1).trim());
      if (label && value && !parsed.has(label)) parsed.set(label, value);
    } else if (/^(бензин|дизель|электро|электричество|гибрид|газ|бензин\s*\/\s*электро.*)$/i.test(line)) parsed.set("Топливо", line);
    else if (/^(автоматическая коробка передач|механическая коробка передач|автомат|механика|вариатор|робот)$/i.test(line)) parsed.set("Коробка передач", line);
    else if (/^(передний|задний|полный) привод$/i.test(line)) parsed.set("Привод", line);
    else if (/^(серый|чёрный|черный|белый|синий|красный|зелёный|зеленый|серебристый|коричневый|бежевый|жёлтый|желтый|оранжевый|фиолетовый)( металлик)?$/i.test(line)) parsed.set("Цвет", line);
    else if (/^(SUV|внедорожник|седан|универсал|х[эе]тчбек|купе|кабриолет|минив[эе]н|пикап)(\s*\/.*)?$/i.test(line)) parsed.set("Кузов", line);
  }
  for (const label of ["Пробег", "Объём двигателя"]) {
    const text = parsed.get(label);
    const value = text ? numeric(text, label === "Объём двигателя") : null;
    if (value !== null) parsed.set(label, `${number(value)} ${label === "Пробег" ? "км" : "см³"}`);
  }
  const registration = listing.first_registration?.value;
  const structured: Array<[string, string | null | undefined]> = [
    ["Год выпуска", listing.production_year ? String(listing.production_year) : null],
    ["Первая регистрация", registration?.match(/^\d{4}-\d{2}$/) ? registration.split("-").reverse().join(".") : registration],
    ["Пробег", listing.mileage_km == null ? null : `${number(listing.mileage_km)} км`],
    ["Объём двигателя", listing.engine_cc == null ? null : `${number(listing.engine_cc)} см³`],
    ["Мощность", listing.power?.value == null ? null : `${number(listing.power.value)} ${listing.power.label_ru || listing.power.unit || "л. с."}`],
    ["Топливо", listing.fuel_type], ["Коробка передач", listing.transmission], ["Привод", listing.drive],
    ["Кузов", listing.body_type], ["Цвет", listing.color],
  ];
  const result: Array<[string, string]> = structured.map(([label, value]) => [label, known(value) || parsed.get(label) || "Не указано"]);
  for (const label of ["Количество дверей", "Количество мест", "Техосмотр", "Количество владельцев"]) {
    const value = parsed.get(label);
    if (value) result.push([label, value]);
  }
  return result;
}
