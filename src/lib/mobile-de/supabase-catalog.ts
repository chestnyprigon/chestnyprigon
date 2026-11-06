import "server-only";

import { createSupabaseEuropePublicServerClient } from "@/lib/supabase/public-client";
import { mobileDeText } from "./normalize";
import type { MobileDeFacets, MobileDeFilters, MobileDeListing, MobileDeListingPage } from "./types";

const listingColumns = [
  "master_id", "source_id", "title", "make", "model", "first_registration",
  "first_registration_precision", "registration_year", "mileage_km", "engine_cc", "power_ps",
  "net_price_amount", "net_price_source_path", "price_status", "price_currency", "price_category", "fuel_type", "transmission", "drive", "body_type",
  "color", "description", "options", "source_url", "primary_image_url", "source_updated_at", "last_seen_at",
  "verified_at", "updated_at",
].join(",");

const TURNKEY_LISTINGS_VIEW = "mobile_de_catalog_turnkey_v2";
const TURNKEY_IMAGES_VIEW = "mobile_de_catalog_turnkey_images_v2";

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
    price: null,
    net_price: { amount: typeof row.net_price_amount === "number" ? row.net_price_amount : null, currency: "EUR", type: "source_netto", basis: "netto", status: "source_reported", source_path: typeof row.net_price_source_path === "string" ? row.net_price_source_path : null },
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
  let query = client.from(TURNKEY_LISTINGS_VIEW).select(listingColumns, { count: "exact" });

  if (filters.make) query = query.eq("make", filters.make);
  if (filters.model) query = query.ilike("model", literalIlikePattern(filters.model));
  if (filters.fuel_type) query = query.eq("fuel_type", filters.fuel_type);
  if (filters.transmission) query = query.eq("transmission", filters.transmission);
  if (filters.body_type) query = query.eq("body_type", filters.body_type);
  if (filters.price_min) query = query.gte("net_price_amount", Number(filters.price_min));
  if (filters.price_max) query = query.lte("net_price_amount", Number(filters.price_max));
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
    price_asc: { column: "net_price_amount", ascending: true }, price_desc: { column: "net_price_amount", ascending: false },
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
  let query = client.from(TURNKEY_LISTINGS_VIEW).select("master_id", { count: "exact", head: true });
  if (filters.make) query = query.eq("make", filters.make);
  if (filters.model) query = query.ilike("model", literalIlikePattern(filters.model));
  if (filters.fuel_type) query = query.eq("fuel_type", filters.fuel_type);
  if (filters.transmission) query = query.eq("transmission", filters.transmission);
  if (filters.body_type) query = query.eq("body_type", filters.body_type);
  if (filters.price_min) query = query.gte("net_price_amount", Number(filters.price_min));
  if (filters.price_max) query = query.lte("net_price_amount", Number(filters.price_max));
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
  const { data, error } = await client.from(TURNKEY_LISTINGS_VIEW).select(listingColumns).eq("master_id", masterId).maybeSingle();
  if (error) throw new Error(`Europe Supabase detail query failed: ${error.message}`);
  if (!data) return null;
  const imagesResult = await client.from(TURNKEY_IMAGES_VIEW).select("source_url,position,is_primary").eq("master_id", masterId).order("position", { ascending: true });
  if (imagesResult.error) throw new Error(`Europe Supabase gallery query failed: ${imagesResult.error.message}`);
  return mapListing(data as unknown as Record<string, unknown>, (imagesResult.data ?? []) as unknown as Array<Record<string, unknown>>);
}

export async function getSupabaseMobileDeFacets(make?: string): Promise<MobileDeFacets> {
  const client = createSupabaseEuropePublicServerClient();
  const { data, error } = await client.rpc("get_mobile_de_catalog_turnkey_facets_v2", { p_make: make || null });
  if (error) throw new Error(`Europe Supabase facets query failed: ${error.message}`);
  const row = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const strings = (key: string) => Array.isArray(row[key]) ? row[key]!.filter((value): value is string => typeof value === "string") : undefined;
  const ranges = row.ranges && typeof row.ranges === "object" && !Array.isArray(row.ranges) ? row.ranges as MobileDeFacets["ranges"] : undefined;
  return { makes: strings("makes"), models: strings("models"), fuel_types: strings("fuel_types"), transmissions: strings("transmissions"), body_types: strings("body_types"), ranges };
}
