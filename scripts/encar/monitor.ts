import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { delay, fetchPublicDetail } from "./client";
import type { EncarDetail, UnknownRecord } from "./types";
import { calculateBelarusPrice, FALLBACK_EXCHANGE_RATES } from "../../src/lib/pricing/chestny-prigon-profile";
import { fetchNbrbRates } from "../../src/lib/pricing/nbrb-rates";
import { loadPersistedPricingProfile } from "../pricing/load-profile";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_DELAY_MS = 1_500;
const DEFAULT_ARCHIVE_AFTER = 3;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function integerArgument(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function isNotFoundError(error: unknown) {
  return error instanceof Error && /HTTP 404/.test(error.message);
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? value as UnknownRecord : {};
}

function sourcePriceKrw(detail: EncarDetail) {
  const advertisement = asRecord(detail.advertisement);
  const raw = advertisement.price;
  const price = Number(raw);
  return Number.isInteger(price) && price > 0 ? price * 10_000 : null;
}

function sourceUpdatedAt(detail: EncarDetail, fallback: string | null) {
  const value = asRecord(detail.manage).modifyDateTime;
  return typeof value === "string" && value.trim() ? value : fallback;
}

function encarRequestId(sourceUrl: string | null, fallback: string) {
  const match = sourceUrl?.match(/[?&]carid=(\d+)/i);
  return match?.[1] ?? fallback;
}

async function main() {
  const batchSize = integerArgument("batch-size", Number(process.env.ENCAR_MONITOR_BATCH_SIZE ?? DEFAULT_BATCH_SIZE), 1, 1_000);
  const concurrency = integerArgument("concurrency", Number(process.env.ENCAR_MONITOR_CONCURRENCY ?? DEFAULT_CONCURRENCY), 1, 2);
  const delayMs = integerArgument("delay-ms", Number(process.env.ENCAR_MONITOR_DELAY_MS ?? DEFAULT_DELAY_MS), 500, 30_000);
  const archiveAfter = integerArgument("archive-after", Number(process.env.ENCAR_MONITOR_ARCHIVE_AFTER ?? DEFAULT_ARCHIVE_AFTER), 2, 5);
  const dryRun = hasFlag("dry-run");

  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const profile = dryRun ? null : await loadPersistedPricingProfile(client);
  const exchangeRates = dryRun ? null : await fetchNbrbRates().catch(() => FALLBACK_EXCHANGE_RATES);

  const { data: candidates, error: candidateError } = await client
    .from("vehicles")
    .select("id,source_listing_id,source_url,price_krw,engine_cc,first_registration_date,fuel_type,source_updated_at,last_checked_at,revalidation_miss_count")
    .eq("status", "active")
    .eq("is_public", true)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .order("source_listing_id", { ascending: true })
    .limit(batchSize);
  if (candidateError) throw new Error(candidateError.message);

  const rows = candidates ?? [];
  const ids = rows.map((vehicle) => String(vehicle.source_listing_id));
  if (!ids.length) {
    console.log({ status: "completed", requested: 0, message: "No public active listings require monitoring" });
    return;
  }

  const startedAt = new Date().toISOString();
  let runId: string | undefined;
  if (!dryRun) {
    const run = await client
      .from("import_runs")
      .insert({
        mode: "refresh",
        status: "running",
        cursor: {
          source: "encar-availability-monitor",
          requested: ids.length,
          batchSize,
          concurrency,
          delayMs,
          archiveAfter,
          dryRun,
          startedAt,
        },
      })
      .select("id")
      .single();
    if (run.error) throw new Error(run.error.message);
    runId = run.data.id;
  }

  const found: string[] = [];
  const missing: string[] = [];
  const failed: Array<{ sourceListingId: string; error: string }> = [];
  const priceChanges: Array<{ id: string; sourceListingId: string; oldPriceKrw: number; newPriceKrw: number; sourceUpdatedAt: string | null }> = [];
  let priceMissing = 0;
  const candidateById = new Map(rows.map((candidate) => [String(candidate.id), candidate]));
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      const sourceListingId = ids[index];
      if (!sourceListingId) return;
      const requestId = encarRequestId(rows[index].source_url, sourceListingId);
      try {
        const detail = await fetchPublicDetail(requestId, { attempts: 1, timeoutMs: 8_000 });
        found.push(sourceListingId);
        const currentPriceKrw = sourcePriceKrw(detail);
        if (currentPriceKrw === null) {
          priceMissing += 1;
        } else if (currentPriceKrw !== Number(rows[index].price_krw)) {
          priceChanges.push({
            id: String(rows[index].id),
            sourceListingId,
            oldPriceKrw: Number(rows[index].price_krw),
            newPriceKrw: currentPriceKrw,
            sourceUpdatedAt: sourceUpdatedAt(detail, rows[index].source_updated_at),
          });
        }
      } catch (error) {
        if (isNotFoundError(error)) missing.push(sourceListingId);
        else failed.push({ sourceListingId: `${sourceListingId} (encar:${requestId})`, error: error instanceof Error ? error.message : String(error) });
      }
      await delay(delayMs);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const checkedAt = new Date().toISOString();
  let applied = { found_count: found.length, missing_count: missing.length, archived_count: 0 };
  if (!dryRun) {
    const { data, error } = await client.rpc("apply_catalog_revalidation", {
      p_found_source_listing_ids: found,
      p_missing_source_listing_ids: missing,
      p_checked_at: checkedAt,
      p_archive_after: archiveAfter,
    });
    if (error) throw new Error(error.message);
    applied = data?.[0] ?? applied;

    if (found.length) {
      const { error: rawError } = await client
        .from("encar_raw_listings")
        .update({ last_seen_at: checkedAt })
        .in("source_listing_id", found);
      if (rawError) throw new Error(rawError.message);
    }

    for (let offset = 0; offset < priceChanges.length; offset += 10) {
      await Promise.all(priceChanges.slice(offset, offset + 10).map(async (change) => {
        const calculation = calculateBelarusPrice({
          priceKrw: change.newPriceKrw,
          engineCc: Number(candidateById.get(change.id)?.engine_cc ?? 0) || null,
          firstRegistrationDate: candidateById.get(change.id)?.first_registration_date ?? null,
          fuelType: String(candidateById.get(change.id)?.fuel_type ?? ""),
          preferential: true,
          profile: profile!,
          exchangeRates: exchangeRates!,
        });
        const { error: updateError } = await client.from("vehicles").update({
          price_krw: change.newPriceKrw,
          price_usd: calculation.totalUsd,
          krw_per_usd: profile!.krwPerUsd,
          source_updated_at: change.sourceUpdatedAt,
        }).eq("id", change.id);
        if (updateError) throw new Error(`${change.sourceListingId}: ${updateError.message}`);
      }));
    }

    if (priceChanges.length) {
      const { error: changeError } = await client.from("catalog_price_changes").insert(priceChanges.map((change) => ({
        vehicle_id: change.id,
        source_listing_id: change.sourceListingId,
        old_price_krw: change.oldPriceKrw,
        new_price_krw: change.newPriceKrw,
        source_updated_at: change.sourceUpdatedAt,
      })));
      if (changeError) throw new Error(changeError.message);
    }
  }

  if (runId) {
    const { error: finishError } = await client
      .from("import_runs")
      .update({
        status: "completed",
        finished_at: new Date().toISOString(),
        fetched_count: ids.length,
        accepted_count: found.length,
        rejected_count: missing.length,
        error_count: failed.length,
        error_summary: failed,
        cursor: {
          source: "encar-availability-monitor",
          requested: ids.length,
          checkedAt,
          foundSourceListingIds: found,
          missingSourceListingIds: missing,
          failedSourceListingIds: failed.map((item) => item.sourceListingId),
          dryRun,
          applied,
          note: "Only confirmed 404 responses count as missing; transient errors never change publication status. Prices are checked from the same detail response and recalculated only when changed.",
        },
      })
      .eq("id", runId);
    if (finishError) throw new Error(finishError.message);
  }

  console.log({
    status: "completed",
    dryRun,
    requested: ids.length,
    found: found.length,
    confirmedMissing: missing.length,
    transientErrors: failed.length,
    errorSamples: failed.slice(0, 5),
    archived: dryRun ? 0 : applied.archived_count,
    priceChecked: found.length,
    priceChanged: priceChanges.length,
    priceMissing,
    recalculated: dryRun ? 0 : priceChanges.length,
    updatedLastSeenAt: dryRun ? 0 : found.length,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
