import { equipmentOptionsFromCodes } from "../../src/data/equipment";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Equipment belongs to the validated detail; choice is only optional extras. */
export function resolveEquipment(detail: unknown, choice: unknown) {
  const codes = object(object(detail).options).standard;
  const standardCodes = Array.isArray(codes) ? [...new Set(codes.filter((code): code is string => typeof code === "string" && /^\d+$/.test(code)))] : [];
  const extras = Array.isArray(choice) ? choice.filter(value => {
    const item = object(value);
    return typeof (item.optionName ?? item.name) === "string" && String(item.optionName ?? item.name).trim().length > 0;
  }) : [];
  const standard = standardCodes.flatMap(code => {
    const named = equipmentOptionsFromCodes([code]);
    return named.length ? named : [{ name: `Опция Encar · код ${code}`, priceKrw: null, description: "Стандартное оборудование, название кода не расшифровано" }];
  });
  return { confirmed: extras.length > 0 || standardCodes.length > 0, standardCodes, standard, extras,
    display: extras.length ? extras : standard };
}
