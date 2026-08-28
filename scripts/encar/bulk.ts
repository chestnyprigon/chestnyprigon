import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createDomesticQuery, delay, fetchBundle, fetchSearchPage } from "./client";
import { encarYearFrom, ENCAR_MAX_MILEAGE_KM } from "./config";
import { normalizeListing } from "./normalize";
import { persistPilot } from "./persistence";
import { screenListing } from "./screening";
import type { PilotItem } from "./types";
import { CATALOG_WAVES, MAX_ENRICH_CONCURRENCY, SAFE_DETAIL_DELAY_MS, selectWaveBatches, type WaveGroup } from "./waves";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const manufacturerAliases: Record<string, string> = {
  Hyundai: "현대",
  Kia: "기아",
  Genesis: "제네시스",
  "Mercedes-Benz": "벤츠",
  Audi: "아우디",
  Volkswagen: "폭스바겐",
};

function integerArgument(name: string, fallback: number, minimum: number, maximum: number) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function nonNegativeIntegerArgument(name: string, fallback: number, maximum: number) {
  return integerArgument(name, fallback, 0, maximum);
}

function groupsArgument() {
  const raw = process.argv.find((argument) => argument.startsWith("--groups="))?.slice("--groups=".length);
  const groups = (raw ?? "european,korean").split(",").map((value) => value.trim()).filter(Boolean) as WaveGroup[];
  if (groups.some((group) => !["european", "korean", "other"].includes(group))) throw new Error("--groups supports european,korean,other");
  return [...new Set(groups)];
}

async function main() {
  const write = process.argv.includes("--write");
  // Publishing before report enrichment would violate the catalogue quality gate.
  if (process.argv.includes("--publish")) throw new Error("bulk intake never publishes; run report enrichment separately");
  const target = integerArgument("target", 2_000, 1, 5_000);
  const pageSize = integerArgument("page-size", 500, 50, 500);
  const detailConcurrency = integerArgument("detail-concurrency", 3, 1, MAX_ENRICH_CONCURRENCY);
  const detailDelayMs = integerArgument("detail-delay-ms", SAFE_DETAIL_DELAY_MS, 100, 10_000);
  const requestedOffset = nonNegativeIntegerArgument("offset", 0, 100_000);
  const now = new Date();
  const requestedWaveId = process.argv.find((argument) => argument.startsWith("--wave="))?.slice("--wave=".length).trim();
  const requestedWave = requestedWaveId ? CATALOG_WAVES.find((wave) => wave.id === requestedWaveId) : undefined;
  if (requestedWaveId && !requestedWave) throw new Error(`unknown wave: ${requestedWaveId}`);
  const batches = requestedWave
    ? [{ wave: requestedWave, offset: requestedOffset, limit: Math.min(target, requestedWave.quota - requestedOffset) }]
    : selectWaveBatches(target, groupsArgument());
  if (requestedWave && requestedOffset >= requestedWave.quota) {
    throw new Error(`offset must be less than wave quota (${requestedWave.quota})`);
  }
  const seen = new Set<string>();
  let fetched = 0;
  let accepted = 0;
  let rejected = 0;

  console.log({ target, batches: batches.map(({ wave, offset, limit }) => ({ id: wave.id, manufacturer: wave.manufacturer, offset, limit })), write, detailConcurrency });

  for (const { wave, offset, limit } of batches) {
    const manufacturer = wave.manufacturer === "*" ? undefined : manufacturerAliases[wave.manufacturer] ?? wave.manufacturer;
    const query = createDomesticQuery(encarYearFrom(now.getFullYear()), now.getFullYear(), ENCAR_MAX_MILEAGE_KM, "Y", manufacturer);
    const page = await fetchSearchPage({ offset, limit: Math.min(pageSize, limit), query });
    const listings = page.listings.filter((listing) => {
      const id = String(listing.Id ?? "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const items: PilotItem[] = [];
    let next = 0;
    async function worker() {
      while (true) {
        const index = next++;
        const listing = listings[index];
        if (!listing) return;
        try {
          const bundle = await fetchBundle(listing);
          const screening = screenListing(bundle);
          items.push({ bundle, screening, normalized: screening.decision === "approved" ? normalizeListing(bundle) : null });
        } catch (error) {
          console.error(`fetch_error ${String(listing.Id)}:`, error instanceof Error ? error.message : error);
        }
        await delay(detailDelayMs);
      }
    }
    await Promise.all(Array.from({ length: Math.min(detailConcurrency, listings.length) }, () => worker()));
    const approved = items.filter((item) => item.normalized).length;
    fetched += items.length;
    accepted += approved;
    rejected += items.length - approved;
    if (write && items.length) {
      await persistPilot(items, false, {
        source: "encar-bulk",
        waveId: wave.id,
        manufacturer: wave.manufacturer,
        offset,
        requested: limit,
        nextOffset: offset + limit,
        publish: false,
      });
    }
    console.log({ wave: wave.id, requested: limit, unique: listings.length, processed: items.length, approved, rejected: items.length - approved, totalFetched: fetched, totalAccepted: accepted });
  }
  console.log({ target, fetched, accepted, rejected, status: "completed", write });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
