import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";
import type { RussiaPriceResult } from "./russia-pricing";
import type { RussiaPriceSnapshotDetails, RussiaPriceSnapshotState } from "./russia-price-snapshot-state";

type SnapshotRow = { listing_id: string; calculation: unknown; status: RussiaPriceSnapshotState; last_error_code: string | null; calculated_at: string | null; updated_at: string };

function isRussiaPriceResult(value: unknown): value is RussiaPriceResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<RussiaPriceResult>;
  return result.destination === "RU"
    && result.currency === "RUB"
    && Number.isFinite(result.totalRub)
    && Boolean(result.commercial && result.government && result.rates);
}

/** Reads successful calculations and current queue state for a bounded page. */
export async function loadRussiaPriceSnapshotDetails(source: "korea" | "europe", listingIds: string[]) {
  const snapshots = new Map<string, RussiaPriceResult>();
  const states = new Map<string, RussiaPriceSnapshotDetails>();
  if (!listingIds.length) return { calculations: snapshots, states };
  const client = createSupabaseAdminClient();
  const { data, error } = await client.from("russia_price_snapshots")
    .select("listing_id,calculation,status,last_error_code,calculated_at,updated_at")
    .eq("source", source).eq("destination", "RU").in("listing_id", listingIds);
  if (error) throw new Error("Could not load stored Russian price snapshots");
  for (const row of (data ?? []) as SnapshotRow[]) {
    states.set(row.listing_id, {
      status: row.status,
      lastErrorCode: row.last_error_code,
      calculatedAt: row.calculated_at,
      updatedAt: row.updated_at,
    });
    if (isRussiaPriceResult(row.calculation)) snapshots.set(row.listing_id, row.calculation);
  }
  return { calculations: snapshots, states };
}

/** Backwards-compatible helper for callers that only need the calculated price. */
export async function loadRussiaPriceSnapshots(source: "korea" | "europe", listingIds: string[]) {
  return (await loadRussiaPriceSnapshotDetails(source, listingIds)).calculations;
}
