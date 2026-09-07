import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { createDomesticQuery, delay, fetchBundle, fetchSearchPage } from "./client";
import { encarYearFrom, ENCAR_MAX_LISTING_AGE_DAYS, ENCAR_MAX_MILEAGE_KM } from "./config";
import { normalizeListing } from "./normalize";
import { persistPilot } from "./persistence";
import { screenListing } from "./screening";
import type { PilotItem } from "./types";
import { CATALOG_WAVES, TARGETED_2016_WAVES } from "./waves";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const manufacturerAliases: Record<string, string> = {
  Hyundai: "현대",
  Kia: "기아",
  Genesis: "제네시스",
  "Mercedes-Benz": "벤츠",
  Audi: "아우디",
  Volkswagen: "폭스바겐",
  Porsche: "포르쉐",
  Volvo: "볼보",
  "Land Rover": "랜드로버",
};

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function integerArgument(name: string, fallback: number, minimum: number, maximum: number) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

async function knownIdentifiers(client: any, ids: string[]) {
  const known = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 200) {
    const chunk = ids.slice(offset, offset + 200);
    const [identifierResult, vehicleResult] = await Promise.all([
      client.from("vehicle_source_identifiers").select("source_identifier").in("source_identifier", chunk),
      client.from("vehicles").select("source_listing_id").in("source_listing_id", chunk),
    ]);
    if (identifierResult.error) throw new Error(identifierResult.error.message);
    if (vehicleResult.error) throw new Error(vehicleResult.error.message);
    for (const row of (identifierResult.data ?? []) as Array<{ source_identifier: string }>) known.add(row.source_identifier);
    for (const row of (vehicleResult.data ?? []) as Array<{ source_listing_id: string }>) known.add(row.source_listing_id);
  }
  return known;
}

async function main() {
  if (!process.argv.includes("--write")) throw new Error("fill-new requires --write");
  const waveId = process.argv.find((argument) => argument.startsWith("--wave="))?.slice("--wave=".length);
  const wave = [...CATALOG_WAVES, ...TARGETED_2016_WAVES].find((item) => item.id === waveId);
  if (!wave) throw new Error("--wave must name a configured catalogue wave");

  const target = integerArgument("target", 50, 1, 1_000);
  const startOffset = integerArgument("offset", 0, 0, 100_000);
  const pageSize = integerArgument("page-size", 50, 50, 100);
  const delayMs = integerArgument("detail-delay-ms", 1_500, 100, 10_000);
  const maxPages = integerArgument("max-pages", 100, 1, 500);
  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const yearFrom = wave.yearFrom ?? encarYearFrom(new Date().getFullYear());
  const manufacturer = wave.manufacturer === "*" ? undefined : manufacturerAliases[wave.manufacturer] ?? wave.manufacturer;
  const query = createDomesticQuery(yearFrom, new Date().getFullYear(), ENCAR_MAX_MILEAGE_KM, "Y", manufacturer);
  const freshnessCutoff = Date.now() - ENCAR_MAX_LISTING_AGE_DAYS * 24 * 60 * 60 * 1_000;

  let offset = startOffset;
  let pages = 0;
  let newVehicles = 0;
  let skippedKnown = 0;
  let rejected = 0;
  let stale = 0;
  let failed = 0;

  while (newVehicles < target && pages < maxPages) {
    const page = await fetchSearchPage({ offset, limit: pageSize, query });
    if (!page.listings.length) break;
    pages += 1;
    offset += pageSize;
    const advertisedIds = page.listings.map((listing) => String(listing.Id ?? "")).filter(Boolean);
    const known = await knownIdentifiers(client, advertisedIds);
    const candidates = page.listings.filter((listing) => !known.has(String(listing.Id ?? "")));
    skippedKnown += page.listings.length - candidates.length;
    const approved: PilotItem[] = [];

    for (const listing of candidates) {
      try {
        const bundle = await fetchBundle(listing);
        const modifiedAt = Date.parse(String(bundle.detail.manage?.modifyDateTime ?? ""));
        if (!Number.isFinite(modifiedAt) || modifiedAt < freshnessCutoff) {
          stale += 1;
          continue;
        }
        const screening = screenListing(bundle);
        if (screening.decision !== "approved") {
          rejected += 1;
          continue;
        }
        const normalized = normalizeListing(bundle);
        const canonicalKnown = await knownIdentifiers(client, [normalized.sourceListingId]);
        if (canonicalKnown.has(normalized.sourceListingId)) {
          skippedKnown += 1;
          continue;
        }
        approved.push({ bundle, screening, normalized });
      } catch (error) {
        failed += 1;
        console.warn(`fetch_error ${String(listing.Id)}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await delay(delayMs);
      }
      if (newVehicles + approved.length >= target) break;
    }

    if (approved.length) {
      await persistPilot(approved, false, {
        source: "encar-fill-new",
        waveId: wave.id,
        manufacturer: wave.manufacturer,
        offset: offset - pageSize,
        requested: pageSize,
        nextOffset: offset,
        publish: false,
      });
      newVehicles += approved.length;
    }
    console.log({ wave: wave.id, pages, nextOffset: offset, newVehicles, target, skippedKnown, rejected, stale, failed });
    if (offset >= page.total) break;
  }

  console.log({ wave: wave.id, target, newVehicles, nextOffset: offset, pages, skippedKnown, rejected, stale, failed, status: newVehicles >= target ? "target_reached" : "source_exhausted" });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
