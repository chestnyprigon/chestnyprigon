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

async function fetchOptions(brand: string, model: string): Promise<CatalogFilterOptions> {
  const client = createSupabasePublicServerClient();
  const { data, error } = await client.rpc("get_catalog_filter_options", {
    p_brand: brand || null,
    p_model: model || null,
  });

  // The SQL function is deployed with the app. Never fall back to reading the
  // full catalogue in pages: that amplified transient database timeouts.
  if (error) throw new Error(`Catalog filter options RPC failed: ${error.message}`);

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
  return loadCachedOptions(brand?.trim() ?? "", model?.trim() ?? "").catch((error: unknown) => {
    console.error("[catalog-filter-options] RPC failed", error instanceof Error ? error.message : "Unknown error");
    // Filter options are supplementary. Preserve catalog availability during
    // a transient RPC failure and avoid issuing a second, unbounded query.
    return { brands: [], models: [], trims: [] };
  });
}
