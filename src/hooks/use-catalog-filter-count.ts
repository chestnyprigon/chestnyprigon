"use client";

import { useEffect, useMemo, useState } from "react";

export type CatalogFilterCountInput = Record<string, string | number | undefined>;

function toQueryString(filters: CatalogFilterCountInput) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return params.toString();
}

/**
 * Filters are applied only after the visitor confirms the form, but the
 * counter is refreshed while they choose values. This keeps the catalogue
 * responsive without reloading a multi-thousand-card result grid per click.
 */
export function useCatalogFilterCount(filters: CatalogFilterCountInput, initialTotal: number) {
  const query = useMemo(() => toQueryString(filters), [filters]);
  const [preview, setPreview] = useState<{ query: string; total: number }>({ query: "", total: initialTotal });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setPending(true);
      try {
        const response = await fetch(`/api/catalog/count?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = await response.json() as { total?: unknown };
        if (typeof payload.total === "number") setPreview({ query, total: payload.total });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          // The current server total remains a useful fallback while offline.
        }
      } finally {
        if (!controller.signal.aborted) setPending(false);
      }
    }, 300);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [query]);

  return { total: preview.query === query ? preview.total : initialTotal, pending };
}
