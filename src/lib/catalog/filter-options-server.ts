import "server-only";

import { unstable_cache } from "next/cache";
import { createSupabasePublicServerClient } from "@/lib/supabase/public-client";

export type CatalogFilterOptions = {
  brands: string[];
  models: string[];
  trims: string[];
};

function sorted(values: Array<string | null | undefined>) {
  return [...new Set(values.flatMap((value) => value?.trim() ? [value.trim()] : []))]
    .sort((left, right) => left.localeCompare(right, "ru"));
}

async function legacyOptions(brand: string, model: string): Promise<CatalogFilterOptions> {
  const client = createSupabasePublicServerClient();
  const rows: Array<{ manufacturer: string | null; model: string | null; trim: string | null }> = [];
  const pageSize = 1_000;

  // Kept only as a safe fallback during rollout, while the SQL migration is
  // being applied. Production normally uses the distinct-values SQL function.
  for (let from = 0; from < 50_000; from += pageSize) {
    let query = client
      .from("vehicles")
      .select("manufacturer,model,trim")
      .eq("is_public", true)
      .eq("status", "active")
      .neq("fuel_type", "전기")
      .neq("fuel_type", "수소")
      .not("price_usd", "is", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (brand) query = query.eq("manufacturer", brand);
    if (model) query = query.eq("model", model);
    const { data, error } = await query;
    if (error) throw new Error(`Catalog filter options request failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }

  return {
    brands: brand ? [] : sorted(rows.map((row) => row.manufacturer)),
    models: brand && !model ? sorted(rows.map((row) => row.model)) : [],
    trims: brand && model ? sorted(rows.map((row) => row.trim)) : [],
  };
}

async function fetchOptions(brand: string, model: string): Promise<CatalogFilterOptions> {
  const client = createSupabasePublicServerClient();
  const { data, error } = await client.rpc("get_catalog_filter_options", {
    p_brand: brand || null,
    p_model: model || null,
  });

  // A deployment can reach Vercel a few seconds before the database migration.
  // Preserve the existing working UI during that short interval instead of
  // showing an empty selector.
  if (error) return legacyOptions(brand, model);

  const value = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  const list = (key: string) => Array.isArray(value[key])
    ? sorted(value[key].filter((item): item is string => typeof item === "string"))
    : [];
  return { brands: list("brands"), models: list("models"), trims: list("trims") };
}

const loadCachedOptions = unstable_cache(
  fetchOptions,
  ["catalog-filter-options-v1"],
  { revalidate: 300 },
);

export function loadCatalogFilterOptions(brand?: string, model?: string) {
  return loadCachedOptions(brand?.trim() ?? "", model?.trim() ?? "");
}
