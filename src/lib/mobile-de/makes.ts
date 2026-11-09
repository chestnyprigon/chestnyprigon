export type MobileDeMakeOption = { value: string; label: string };

const canonicalLabels: Record<string, string> = {
  audi: "Audi",
  bmw: "BMW",
  citroen: "Citroen",
  fiat: "Fiat",
  man: "MAN",
  mercedesbenz: "Mercedes-Benz",
  opel: "Opel",
  peugeot: "Peugeot",
  renault: "Renault",
  seat: "SEAT",
  volkswagen: "Volkswagen",
};

export function mobileDeMakeKey(value: string) {
  const key = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
  if (key === "mercedes" || key === "mercedesbenz") return "mercedesbenz";
  if (key === "vw" || key === "volkswagen") return "volkswagen";
  return key;
}

function preferredValue(values: string[], label: string) {
  return [...values].sort((a, b) => {
    const aLabel = a === label ? 0 : 1;
    const bLabel = b === label ? 0 : 1;
    const aUpper = a === a.toLocaleUpperCase("en-US") ? 1 : 0;
    const bUpper = b === b.toLocaleUpperCase("en-US") ? 1 : 0;
    return aLabel - bLabel || aUpper - bUpper || a.localeCompare(b, "en-US");
  })[0];
}

export function normalizeMobileDeMakes(values: string[]): MobileDeMakeOption[] {
  const groups = new Map<string, string[]>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = mobileDeMakeKey(normalized);
    const group = groups.get(key);
    if (group) group.push(normalized);
    else groups.set(key, [normalized]);
  }
  return [...groups.entries()]
    .map(([key, aliases]) => {
      const label = canonicalLabels[key] ?? aliases[0]!;
      return { value: preferredValue(aliases, label), label };
    })
    .sort((a, b) => a.label.localeCompare(b.label, "ru", { numeric: true }));
}
