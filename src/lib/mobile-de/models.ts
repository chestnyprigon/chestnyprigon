import { mobileDeMakeKey, normalizeMobileDeMakes } from "./makes";

/** Case-insensitive model key used to collapse source spelling variants in the filter. */
export function mobileDeModelKey(value: string, make?: string | null) {
  return modelWithoutMake(value, make).toLocaleLowerCase("en-US");
}

function modelCasePenalty(value: string) {
  const letters = [...value].filter((character) => /[a-z]/i.test(character));
  if (!letters.length) return 0;
  if (/^[a-z]/.test(value)) return 3;
  if (!/^[a-z]/i.test(value) && /[A-Z]+$/.test(value)) return 1;
  if (letters.length > 1 && letters.every((character) => character === character.toLocaleUpperCase("en-US"))) return 2;
  return 0;
}

function preferredModelSpelling(values: string[]) {
  return [...values].sort((left, right) =>
    modelCasePenalty(left) - modelCasePenalty(right) || left.localeCompare(right, "en-US"),
  )[0];
}

/** Collapses model names that differ only by letter casing, keeping one readable label. */
export function normalizeMobileDeModels(values: string[], make?: string | null) {
  const groups = new Map<string, string[]>();
  for (const raw of values) {
    const value = modelWithoutMake(raw, make);
    if (!value) continue;
    const key = mobileDeModelKey(value);
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return [...groups.values()].map(preferredModelSpelling).sort((left, right) => left.localeCompare(right, "ru", { numeric: true }));
}


function removePrefix(value: string, key: string, normalize: (value: string) => string): string | undefined {
  // Check complete words only, so a model such as MAN TGE never affects another brand.
  const words = value.split(" ");
  for (let length = Math.min(words.length, 3); length > 0; length--) {
    if (normalize(words.slice(0, length).join(" ")) === key) return words.slice(length).join(" ");
  }
}

export function modelWithoutMake(value: string, make?: string | null) {
  let model = value.trim().replace(/\s+/g, " ");
  const key = make && mobileDeMakeKey(make);
  if (!key) return model;
  for (let remainder = removePrefix(model, key, mobileDeMakeKey); remainder !== undefined; remainder = removePrefix(model, key, mobileDeMakeKey)) {
    model = remainder;
  }
  return model;
}

export function vehicleDisplayName(make?: string | null, model?: string | null, sourceTitle?: string | null) {
  const brand = make?.trim() ? normalizeMobileDeMakes([make])[0]?.label : undefined;
  const name = modelWithoutMake(model ?? "", brand);
  const title = modelWithoutMake(sourceTitle ?? "", brand);
  const base = [brand, name || title].filter(Boolean).join(" ");
  const trim = name && title.toLowerCase().startsWith(name.toLowerCase() + " ")
    ? title.slice(name.length).trim()
    : "";
  return { name: base || "Автомобиль", trim };
}
