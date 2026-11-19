/** Curated model families shown in the two homepage catalogue showcases. */
export type HomepageModelPriority = {
  make: string;
  makeAliases?: readonly string[];
  model: string;
  modelAliases: readonly string[];
  /** Variant names may be recorded in model, generation, trim, or source title. */
  variantAliases?: readonly string[];
  variantMatch?: "any" | "all";
};

export const KOREA_HOMEPAGE_MODEL_PRIORITIES: readonly HomepageModelPriority[] = [
  { make: "Hyundai", makeAliases: ["현대"], model: "Palisade", modelAliases: ["Palisade", "팰리세이드"] },
  { make: "Hyundai", makeAliases: ["현대"], model: "Tucson", modelAliases: ["Tucson", "투싼"] },
  { make: "Hyundai", makeAliases: ["현대"], model: "Santa Fe", modelAliases: ["Santa Fe", "Santafe", "싼타페"] },
  { make: "Mercedes-Benz", makeAliases: ["Mercedes", "벤츠"], model: "GLC", modelAliases: ["GLC", "GLC-Class", "GLC클래스"] },
  { make: "Mercedes-Benz", makeAliases: ["Mercedes", "벤츠"], model: "CLS", modelAliases: ["CLS", "CLS-Class", "CLS클래스"] },
  { make: "Mercedes-Benz", makeAliases: ["Mercedes", "벤츠"], model: "GLE", modelAliases: ["GLE", "GLE-Class", "GLE클래스"], variantAliases: ["400d", "4MATIC Coupe"], variantMatch: "all" },
  { make: "Kia", makeAliases: ["기아"], model: "Carnival", modelAliases: ["Carnival", "Canival", "카니발"] },
  { make: "Kia", makeAliases: ["기아"], model: "Sorento", modelAliases: ["Sorento", "쏘렌토"] },
  { make: "Kia", makeAliases: ["기아"], model: "Mohave", modelAliases: ["Mohave", "모하비"] },
  { make: "Kia", makeAliases: ["기아"], model: "Sportage", modelAliases: ["Sportage", "스포티지"] },
  { make: "BMW", model: "5 Series", modelAliases: ["5 Series", "5시리즈", "5er", "523d"], variantAliases: ["523d", "M Sport"], variantMatch: "all" },
  { make: "Audi", makeAliases: ["아우디"], model: "Q8", modelAliases: ["Q8"] },
];

export const EUROPE_HOMEPAGE_MODEL_PRIORITIES: readonly HomepageModelPriority[] = [
  { make: "Opel", model: "Insignia", modelAliases: ["Insignia"] },
  { make: "Peugeot", model: "3008", modelAliases: ["3008"] },
  { make: "Renault", model: "Megane", modelAliases: ["Megane", "Mégane"] },
  { make: "SEAT", model: "Ateca", modelAliases: ["Ateca"] },
  { make: "Volkswagen", makeAliases: ["VW", "Volkswagen"], model: "Polo", modelAliases: ["Polo"] },
  { make: "Volkswagen", makeAliases: ["VW", "Volkswagen"], model: "Golf", modelAliases: ["Golf"] },
  { make: "Volkswagen", makeAliases: ["VW", "Volkswagen"], model: "Passat", modelAliases: ["Passat"] },
  { make: "Citroën", makeAliases: ["Citroen", "Citroën"], model: "Spacetourer", modelAliases: ["Spacetourer", "SpaceTourer"] },
  { make: "Mercedes-Benz", makeAliases: ["Mercedes", "Mercedes-Benz"], model: "Sprinter", modelAliases: ["Sprinter"] },
  { make: "Audi", model: "Q3", modelAliases: ["Q3"] },
  { make: "BMW", model: "X1", modelAliases: ["X1"] },
  { make: "BMW", model: "3 Series 318", modelAliases: ["3 Series", "3er", "3-Serie", "3시리즈", "318", "318d", "318i"], variantAliases: ["318", "318d", "318i"] },
];

function normalized(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]/gu, "");
}

function makeKey(value: string) {
  const key = normalized(value);
  if (key === "vw") return "volkswagen";
  if (key === "mercedes") return "mercedesbenz";
  return key;
}

export function homepageModelPriorityIndex(
  make: string | null | undefined,
  modelFields: readonly (string | null | undefined)[],
  priorities: readonly HomepageModelPriority[],
) {
  if (!make) return -1;
  const makeKey = makeKeyForPriority(make);
  const fields = modelFields.filter((value): value is string => Boolean(value?.trim())).map(normalized);
  return priorities.findIndex((target) => {
    const acceptedMakes = [target.make, ...(target.makeAliases ?? [])].map(makeKeyForPriority);
    if (!acceptedMakes.some((candidate) => makeKey === candidate || makeKey.startsWith(candidate))) return false;
    const modelAliases = target.modelAliases.map(normalized).filter(Boolean);
    const variantAliases = (target.variantAliases ?? []).map(normalized).filter(Boolean);
    const combinedFields = fields.join(" ");
    const hasModel = fields.some((field) => modelAliases.some((alias) => field.includes(alias)))
      || modelAliases.some((alias) => combinedFields.includes(alias));
    const hasVariant = !variantAliases.length || (target.variantMatch === "all"
      ? variantAliases.every((alias) => combinedFields.includes(alias))
      : variantAliases.some((alias) => combinedFields.includes(alias)));
    return hasModel && hasVariant;
  });
}

function makeKeyForPriority(value: string) {
  return makeKey(value);
}

/** PostgREST OR filter scoped to the configured make/model pairs. */
export function homepageModelPostgrestFilter(
  priorities: readonly HomepageModelPriority[],
  fields: { make: string; models: readonly string[] },
) {
  const clauses: string[] = [];
  const pattern = (value: string) => value.replace(/[(),*\\]/g, " ").trim();
  for (const target of priorities) {
    const makes = [...new Set([target.make, ...(target.makeAliases ?? [])])]
      .map(pattern).filter(Boolean).map((value) => `${fields.make}.ilike.*${value}*`);
    const filtersFor = (terms: readonly string[]) => [...new Set(terms.flatMap((term) => fields.models.map((field) => `${field}.ilike.*${pattern(term)}*`)))];
    const modelFilters = filtersFor(target.modelAliases);
    const variantFilters = target.variantAliases?.length ? filtersFor(target.variantAliases) : [];
    if (!makes.length || !modelFilters.length) continue;
    const parts = [makes.length > 1 ? `or(${makes.join(",")})` : makes[0], `or(${modelFilters.join(",")})`];
    if (variantFilters.length) {
      if (target.variantMatch === "all") parts.push(...target.variantAliases!.map((term) => `or(${filtersFor([term]).join(",")})`));
      else parts.push(`or(${variantFilters.join(",")})`);
    }
    clauses.push(`and(${parts.join(",")})`);
  }
  return clauses.length ? clauses.join(",") : null;
}

/** Give each configured model one newest listing first, then fill remaining slots round-robin. */
export function selectHomepagePriorityRows<T>(
  rows: readonly T[],
  limit: number,
  priorities: readonly HomepageModelPriority[],
  getValues: (row: T) => { make: string | null | undefined; modelFields: readonly (string | null | undefined)[] },
) {
  const buckets = priorities.map(() => [] as T[]);
  for (const row of rows) {
    const values = getValues(row);
    const index = homepageModelPriorityIndex(values.make, values.modelFields, priorities);
    if (index >= 0) buckets[index]!.push(row);
  }
  const selected: T[] = [];
  for (let round = 0; selected.length < limit; round += 1) {
    let added = false;
    for (const bucket of buckets) {
      const row = bucket[round];
      if (!row) continue;
      selected.push(row);
      added = true;
      if (selected.length === limit) break;
    }
    if (!added) break;
  }
  return selected;
}
