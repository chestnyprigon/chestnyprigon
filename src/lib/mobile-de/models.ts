/** Case-insensitive model key used to collapse source spelling variants in the filter. */
export function mobileDeModelKey(value: string) {
  return value.toLocaleLowerCase("en-US");
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
export function normalizeMobileDeModels(values: string[]) {
  const groups = new Map<string, string[]>();
  for (const value of values) {
    const key = mobileDeModelKey(value);
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return [...groups.values()].map(preferredModelSpelling).sort((left, right) => left.localeCompare(right, "ru"));
}
