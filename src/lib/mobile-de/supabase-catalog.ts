import "server-only";

import { createSupabaseEuropePublicServerClient } from "@/lib/supabase/public-client";
import { mobileDeText } from "./normalize";
import { mobileDeMakeKey } from "./makes";
import type { MobileDeFacets, MobileDeFilters, MobileDeListing, MobileDeListingPage } from "./types";

const listingColumns = [
  "master_id", "source_id", "title", "make", "model", "first_registration",
  "first_registration_precision", "registration_year", "mileage_km", "engine_cc", "power_ps",
  "price_amount", "price_currency", "price_category", "fuel_type", "transmission", "drive", "body_type",
  "transport_class", "customer_cohort", "model_group", "source_gross_amount", "reported_net_amount", "price_basis",
  "color", "description", "options", "source_url", "primary_image_url", "source_updated_at", "last_seen_at",
  "verified_at", "updated_at",
].join(",");

function normalizedQuery(filters: MobileDeFilters) {
  return JSON.stringify(Object.fromEntries(Object.entries(filters).filter(([key, value]) => key !== "cursor" && value).sort(([a], [b]) => a.localeCompare(b))));
}

function cursorFor(offset: number, query: string) {
  return Buffer.from(JSON.stringify({ version: 1, offset, query })).toString("base64url");
}

function offsetFromCursor(cursor: string | undefined, query: string) {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { version?: number; offset?: number; query?: string };
    if (value.version !== 1 || value.query !== query || !Number.isSafeInteger(value.offset) || value.offset! < 0 || value.offset! > 100_000) {
      throw new Error("Invalid page cursor");
    }
    return value.offset!;
  } catch {
    throw new Error("Invalid Europe catalogue cursor");
  }
}

function literalIlikePattern(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/([%_])/g, "\\$1");
}

function applyMakeFilter<T extends { ilike: (column: string, pattern: string) => T; or: (filters: string) => T }>(query: T, make: string) {
  const key = mobileDeMakeKey(make);
  if (key === "mercedesbenz") return query.ilike("make", "%mercedes%");
  if (key === "volkswagen") return query.or("make.ilike.*Volkswagen*,make.ilike.VW");
  if (key === "citroen") return query.or("make.ilike.*Citroen*,make.ilike.*Citroën*");
  return query.ilike("make", literalIlikePattern(make));
}

function mapListing(row: Record<string, unknown>, gallery?: Array<Record<string, unknown>>): MobileDeListing {
  const options = Array.isArray(row.options) ? row.options.flatMap((item) => mobileDeText(item) || []) : [];
  const images = gallery?.map((item) => ({
    url: String(item.source_url),
    position: Number(item.position),
    is_primary: item.is_primary === true,
  })) ?? [];
  const primaryUrl = typeof row.primary_image_url === "string" ? row.primary_image_url : images[0]?.url ?? null;
  return {
    master_id: String(row.master_id),
    source: "mobile_de",
    source_id: String(row.source_id),
    title: String(row.title),
    make: typeof row.make === "string" ? row.make : null,
    model: typeof row.model === "string" ? row.model : null,
    first_registration: row.first_registration ? { value: String(row.first_registration), precision: String(row.first_registration_precision) } : null,
    mileage_km: typeof row.mileage_km === "number" ? row.mileage_km : null,
    engine_cc: typeof row.engine_cc === "number" ? row.engine_cc : null,
    power: { value: typeof row.power_ps === "number" ? row.power_ps : null, unit: "PS", label_ru: "л. с." },
    price: {
      amount: typeof row.price_amount === "number" ? row.price_amount : null,
      currency: typeof row.price_currency === "string" ? row.price_currency : "EUR",
      type: "source_asking",
      basis: row.price_basis === "netto" || row.price_basis === "brutto" ? row.price_basis : "unknown",
      gross_amount: typeof row.source_gross_amount === "number" ? row.source_gross_amount : null,
      provenance: row.price_provenance && typeof row.price_provenance === "object" && !Array.isArray(row.price_provenance) ? row.price_provenance as Record<string, unknown> : null,
    },
    net_price: typeof row.reported_net_amount === "number" && row.reported_net_amount > 0
      ? { amount: row.reported_net_amount, currency: "EUR", type: "source_netto", basis: "netto", status: "source_reported", source_path: "price.nt.amount" }
      : null,
    transport_class: row.transport_class === "VAN" ? "VAN" : "CAR",
    customer_cohort: typeof row.customer_cohort === "string" ? row.customer_cohort : null,
    model_group: typeof row.model_group === "string" ? row.model_group : null,
    primary_image: primaryUrl ? { url: primaryUrl, position: 0, is_primary: true } : null,
    freshness: { availability: "unknown", source_updated_at: typeof row.source_updated_at === "string" ? row.source_updated_at : null, master_updated_at: typeof row.updated_at === "string" ? row.updated_at : null, last_successful_source_check_at: typeof row.verified_at === "string" ? row.verified_at : null },
    fuel_type: typeof row.fuel_type === "string" ? row.fuel_type : null,
    transmission: typeof row.transmission === "string" ? row.transmission : null,
    drive: typeof row.drive === "string" ? row.drive : null,
    body_type: typeof row.body_type === "string" ? row.body_type : null,
    color: typeof row.color === "string" ? row.color : null,
    description: typeof row.description === "string" ? row.description : null,
    options,
    ...(gallery ? { gallery: images } : {}),
  };
}

export async function getSupabaseMobileDeListings(filters: MobileDeFilters): Promise<MobileDeListingPage> {
  const client = createSupabaseEuropePublicServerClient();
  const queryKey = normalizedQuery(filters);
  const offset = offsetFromCursor(filters.cursor, queryKey);
  const limit = Math.min(50, Math.max(1, Number(filters.limit) || 20));
  let query = client.from("mobile_de_catalog_public_listings").select(listingColumns, { count: "exact" });

  if (filters.make) query = applyMakeFilter(query, filters.make);
  if (filters.model) query = query.ilike("model", literalIlikePattern(filters.model));
  if (filters.fuel_type) query = query.eq("fuel_type", filters.fuel_type);
  if (filters.transmission) query = query.eq("transmission", filters.transmission);
  if (filters.body_type) query = query.eq("body_type", filters.body_type);
  if (filters.price_min) query = query.gte("price_amount", Number(filters.price_min));
  if (filters.price_max) query = query.lte("price_amount", Number(filters.price_max));
  if (filters.registration_year_min) query = query.gte("registration_year", Number(filters.registration_year_min));
  if (filters.registration_year_max) query = query.lte("registration_year", Number(filters.registration_year_max));
  if (filters.mileage_min) query = query.gte("mileage_km", Number(filters.mileage_min));
  if (filters.mileage_max) query = query.lte("mileage_km", Number(filters.mileage_max));
  if (filters.power_min) query = query.gte("power_ps", Number(filters.power_min));
  if (filters.power_max) query = query.lte("power_ps", Number(filters.power_max));
  if (filters.engine_cc_min) query = query.gte("engine_cc", Number(filters.engine_cc_min));
  if (filters.engine_cc_max) query = query.lte("engine_cc", Number(filters.engine_cc_max));

  const sort = filters.sort || "updated_desc";
  const sortBy: Record<string, { column: string; ascending: boolean }> = {
    price_asc: { column: "price_amount", ascending: true }, price_desc: { column: "price_amount", ascending: false },
    mileage_asc: { column: "mileage_km", ascending: true }, mileage_desc: { column: "mileage_km", ascending: false },
    updated_asc: { column: "source_updated_at", ascending: true }, updated_desc: { column: "source_updated_at", ascending: false },
  };
  const ordering = sortBy[sort] || sortBy.updated_desc;
  const { data, error, count } = await query
    .order(ordering.column, { ascending: ordering.ascending, nullsFirst: false })
    .order("master_id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`Europe Supabase listing query failed: ${error.message}`);
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  const total = count ?? 0;
  const nextOffset = offset + rows.length;
  const hasMore = nextOffset < total;
  return {
    api_version: "mobile-de-supabase/v1",
    data: rows.map((row) => mapListing(row)),
    page: { limit, has_more: hasMore, next_cursor: hasMore ? cursorFor(nextOffset, queryKey) : null },
  };
}

export async function getSupabaseMobileDeCount(filters: MobileDeFilters): Promise<number> {
  const client = createSupabaseEuropePublicServerClient();
  let query = client.from("mobile_de_catalog_public_listings").select("master_id", { count: "exact", head: true });
  if (filters.make) query = applyMakeFilter(query, filters.make);
  if (filters.model) query = query.ilike("model", literalIlikePattern(filters.model));
  if (filters.fuel_type) query = query.eq("fuel_type", filters.fuel_type);
  if (filters.transmission) query = query.eq("transmission", filters.transmission);
  if (filters.body_type) query = query.eq("body_type", filters.body_type);
  if (filters.price_min) query = query.gte("price_amount", Number(filters.price_min));
  if (filters.price_max) query = query.lte("price_amount", Number(filters.price_max));
  if (filters.registration_year_min) query = query.gte("registration_year", Number(filters.registration_year_min));
  if (filters.registration_year_max) query = query.lte("registration_year", Number(filters.registration_year_max));
  if (filters.mileage_min) query = query.gte("mileage_km", Number(filters.mileage_min));
  if (filters.mileage_max) query = query.lte("mileage_km", Number(filters.mileage_max));
  if (filters.power_min) query = query.gte("power_ps", Number(filters.power_min));
  if (filters.power_max) query = query.lte("power_ps", Number(filters.power_max));
  if (filters.engine_cc_min) query = query.gte("engine_cc", Number(filters.engine_cc_min));
  if (filters.engine_cc_max) query = query.lte("engine_cc", Number(filters.engine_cc_max));
  const { count, error } = await query;
  if (error) throw new Error(`Europe Supabase count query failed: ${error.message}`);
  return count ?? 0;
}

export async function getSupabaseMobileDeListing(masterId: string): Promise<MobileDeListing | null> {
  const client = createSupabaseEuropePublicServerClient();
  const [listingResult, imagesResult] = await Promise.all([
    client.from("mobile_de_catalog_public_listings").select(listingColumns).eq("master_id", masterId).maybeSingle(),
    client.from("mobile_de_catalog_public_images").select("source_url,position,is_primary").eq("master_id", masterId).order("position", { ascending: true }),
  ]);
  const { data, error } = listingResult;
  if (error) throw new Error(`Europe Supabase detail query failed: ${error.message}`);
  if (imagesResult.error) throw new Error(`Europe Supabase gallery query failed: ${imagesResult.error.message}`);
  if (!data) return null;
  return mapListing(data as unknown as Record<string, unknown>, (imagesResult.data ?? []) as unknown as Array<Record<string, unknown>>);
}

export async function getSupabaseMobileDeFacets(make?: string): Promise<MobileDeFacets> {
  const client = createSupabaseEuropePublicServerClient();
  const readFacets = async (selectedMake: string | null) => {
    const { data, error } = await client.rpc("get_mobile_de_catalog_facets", { p_make: selectedMake });
    if (error) throw new Error(`Europe Supabase facets query failed: ${error.message}`);
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  };
  const row = await readFacets(null);
  const strings = (source: Record<string, unknown>, key: string) => Array.isArray(source[key]) ? source[key]!.filter((value): value is string => typeof value === "string") : [];
  const rawMakes = strings(row, "makes");
  if (!make) {
    const ranges = row.ranges && typeof row.ranges === "object" && !Array.isArray(row.ranges) ? row.ranges as MobileDeFacets["ranges"] : undefined;
    return { makes: rawMakes, ranges };
  }

  const aliases = rawMakes.filter((value) => mobileDeMakeKey(value) === mobileDeMakeKey(make));
  const selectedRows = await Promise.all((aliases.length ? aliases : [make]).map(readFacets));
  const merge = (key: string) => [...new Set(selectedRows.flatMap((source) => strings(source, key)))];
  const rangeRows = selectedRows.flatMap((source) => source.ranges && typeof source.ranges === "object" && !Array.isArray(source.ranges) ? [source.ranges as Record<string, unknown>] : []);
  const ranges: NonNullable<MobileDeFacets["ranges"]> = {};
  for (const rangeKey of new Set(rangeRows.flatMap((range) => Object.keys(range)))) {
    const numbers = rangeRows.map((range) => range[rangeKey]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (!numbers.length) continue;
    if (rangeKey.endsWith("_min")) ranges[rangeKey] = Math.min(...numbers);
    else if (rangeKey.endsWith("_max")) ranges[rangeKey] = Math.max(...numbers);
    else if (rangeKey === "count") ranges[rangeKey] = numbers.reduce((sum, value) => sum + value, 0);
    else ranges[rangeKey] = numbers[0];
  }
  return {
    makes: aliases,
    models: merge("models"),
    fuel_types: merge("fuel_types"),
    transmissions: merge("transmissions"),
    body_types: merge("body_types"),
    ranges,
  };
}
