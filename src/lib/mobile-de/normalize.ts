/** Master API can return translated text together with translation metadata. */
export function mobileDeText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["text_ru", "label_ru", "text", "value", "name", "original", "text_original"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return null;
}

export function normalizeMobileDeListing<T extends Record<string, unknown>>(listing: T): T {
  const normalized: Record<string, unknown> = { ...listing };
  for (const key of ["title", "make", "model", "description", "fuel_type", "transmission", "drive", "body_type", "color"]) {
    normalized[key] = mobileDeText(listing[key]);
  }
  normalized.options = Array.isArray(listing.options) ? listing.options.flatMap((option: unknown) => {
    const text = mobileDeText(option);
    return text ? [text] : [];
  }) : [];
  return normalized as T;
}
