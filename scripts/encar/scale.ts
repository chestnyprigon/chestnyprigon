import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { createDomesticQuery, delay, fetchBundle, fetchSearchPage } from "./client";
import { normalizeListing } from "./normalize";
import { persistPilot } from "./persistence";
import { screenListing } from "./screening";
import type { EncarSearchListing, PilotItem } from "./types";
import { encarYearFrom, ENCAR_MAX_MILEAGE_KM } from "./config";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

function integerArgument(name: string, fallback: number, minimum: number, maximum: number) {
  const prefix = `--${name}=`;
  const raw = process.argv.slice(2).find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function requireEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const target = integerArgument("target", 1_000, 1, 10_000);
const pageSize = integerArgument("page-size", 100, 20, 100);
const batchSize = integerArgument("batch-size", 20, 5, 50);
const detailDelayMs = integerArgument("detail-delay-ms", 300, 100, 10_000);
const detailConcurrency = integerArgument("detail-concurrency", 1, 1, 4);
const searchOffsetArgument = integerArgument("search-offset", 0, 0, 60_000);

async function main() {
  const client = createClient(
    requireEnvironment("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const rawCount = async () => {
    const { count, error } = await client.from("encar_raw_listings").select("*", { count: "exact", head: true });
    if (error) throw new Error(error.message);
    return count ?? 0;
  };

  let stored = await rawCount();
  if (stored >= target) {
    console.log({ target, stored, message: "Target already reached" });
    return;
  }

  const now = new Date();
  const query = createDomesticQuery(encarYearFrom(now.getFullYear()), now.getFullYear(), ENCAR_MAX_MILEAGE_KM);
  const desired = target - stored;
  const snapshotSize = Math.ceil((desired + Math.max(200, desired * 0.25)) / pageSize) * pageSize;
  const snapshot: EncarSearchListing[] = [];
  const advertisedIds = new Set<string>();

  console.log(`Collecting a stable search snapshot for target ${target}; currently stored ${stored}.`);
  const initialSearchOffset = searchOffsetArgument || stored;
  for (let offset = initialSearchOffset; snapshot.length < snapshotSize; offset += pageSize) {
    const page = await fetchSearchPage({ offset, limit: pageSize, query });
    for (const listing of page.listings) {
      const id = String(listing.Id ?? "");
      if (id && !advertisedIds.has(id)) {
        advertisedIds.add(id);
        snapshot.push(listing);
      }
    }
    console.log(`Snapshot: ${snapshot.length}/${snapshotSize} listings (offset ${offset}).`);
    if (!page.listings.length || offset + pageSize >= page.total) break;
    await delay(250);
  }

  let cursor = 0;
  let fetchErrors = 0;
  while (stored < target && cursor < snapshot.length) {
    const remaining = target - stored;
    const take = Math.min(batchSize, remaining, snapshot.length - cursor);
    const listings = snapshot.slice(cursor, cursor + take);
    cursor += take;
    const items: PilotItem[] = [];

    for (let start = 0; start < listings.length; start += detailConcurrency) {
      const group = listings.slice(start, start + detailConcurrency);
      const results = await Promise.all(group.map(async (listing, index) => {
        await delay(index * detailDelayMs);
        try {
          const bundle = await fetchBundle(listing);
          const screening = screenListing(bundle);
          return {
            bundle,
            screening,
            normalized: screening.decision === "approved" ? normalizeListing(bundle) : null,
          } satisfies PilotItem;
        } catch (error) {
          fetchErrors += 1;
          console.error(`${String(listing.Id)} fetch_error:`, error instanceof Error ? error.message : error);
          return null;
        }
      }));
      items.push(...results.filter((item): item is PilotItem => item !== null));
    }

    if (items.length) await persistPilot(items, false);
    stored = await rawCount();
    console.log({ target, stored, snapshotCursor: cursor, snapshotSize: snapshot.length, fetchErrors });
  }

  if (stored < target) {
    throw new Error(`Snapshot exhausted at ${stored}/${target}; rerun safely to continue with a fresh snapshot.`);
  }
  console.log({ target, stored, fetchErrors, status: "target_reached" });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
