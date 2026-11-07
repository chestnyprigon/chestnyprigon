import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";
import type { RussiaPriceResult } from "./russia-pricing";
import { calculateRussiaVehiclePrices, type CatalogVehicle } from "./russia-vehicle-pricing";

type SnapshotRow = { listing_id: string; calculation: unknown; status: string };

function isRussiaPriceResult(value: unknown): value is RussiaPriceResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<RussiaPriceResult>;
  return result.destination === "RU"
    && result.currency === "RUB"
    && Number.isFinite(result.totalRub)
    && Boolean(result.commercial && result.government && result.rates);
}

/** Reads the latest successful snapshot for a bounded page of catalogue IDs. */
export async function loadRussiaPriceSnapshots(source: "korea" | "europe", listingIds: string[]) {
  const snapshots = new Map<string, RussiaPriceResult>();
  if (!listingIds.length) return snapshots;
  const client = createSupabaseAdminClient();
  const { data, error } = await client.from("russia_price_snapshots")
    .select("listing_id,calculation,status")
    .eq("source", source).eq("destination", "RU").in("listing_id", listingIds);
  if (error) throw new Error("Could not load stored Russian price snapshots");
  for (const row of (data ?? []) as SnapshotRow[]) {
    if (isRussiaPriceResult(row.calculation)) snapshots.set(row.listing_id, row.calculation);
  }
  return snapshots;
}

/** Keep the previous cached calculation path available for listings still in the initial backfill. */
export async function loadRussiaPriceSnapshotsOrCalculate(
  source: "korea" | "europe",
  entries: Array<{ listingId: string; vehicle: CatalogVehicle }>,
) {
  const snapshots = await loadRussiaPriceSnapshots(source, entries.map((entry) => entry.listingId));
  const missing = entries.filter((entry) => !snapshots.has(entry.listingId));
  if (!missing.length) return snapshots;
  const calculations = await calculateRussiaVehiclePrices(missing.map((entry) => entry.vehicle));
  missing.forEach((entry, index) => {
    const calculation = calculations[index];
    if (calculation) snapshots.set(entry.listingId, calculation);
  });
  return snapshots;
}
