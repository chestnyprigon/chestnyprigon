import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createDomesticQuery, delay, fetchBundle, fetchSearchPage } from "./client";
import { normalizeListing } from "./normalize";
import { persistPilot } from "./persistence";
import { screenListing } from "./screening";
import type { PilotItem } from "./types";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const args = new Set(process.argv.slice(2));

function numericArgument(name: string, fallback: number, maximum: number) {
  const prefix = `--${name}=`;
  const raw = process.argv.slice(2).find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  const parsed = raw ? Number(raw) : fallback;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`--${name} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

const limit = numericArgument("limit", Number(process.env.ENCAR_PILOT_LIMIT ?? 20), 100);
const detailDelayMs = numericArgument(
  "detail-delay-ms",
  Number(process.env.ENCAR_DETAIL_DELAY_MS ?? 350),
  10_000,
);
const write = args.has("--write");
const publish = args.has("--publish");

if (publish && !write) throw new Error("--publish requires --write");

async function main() {
  const now = new Date();
  const query = createDomesticQuery(now.getFullYear() - 5, now.getFullYear(), 150_000);
  const page = await fetchSearchPage({ offset: 0, limit, query });
  const items: PilotItem[] = [];

  console.log(`Encar reports ${page.total.toLocaleString("en-US")} matching domestic listings before screening.`);
  console.log(`Fetching ${page.listings.length} listings (${write ? "write" : "dry-run"}${publish ? ", publish" : ""}).`);

  for (const [index, listing] of page.listings.entries()) {
    try {
      const bundle = await fetchBundle(listing);
      const screening = screenListing(bundle);
      items.push({
        bundle,
        screening,
        normalized: screening.decision === "approved" ? normalizeListing(bundle) : null,
      });
      console.log(
        `[${index + 1}/${page.listings.length}] ${String(listing.Id)} ${screening.decision}` +
          (screening.reasonCodes.length ? ` (${screening.reasonCodes.join(", ")})` : ""),
      );
    } catch (error) {
      console.error(
        `[${index + 1}/${page.listings.length}] ${String(listing.Id)} fetch_error:`,
        error instanceof Error ? error.message : error,
      );
    }
    if (index < page.listings.length - 1) await delay(detailDelayMs);
  }

  const decisions = items.reduce<Record<string, number>>((counts, item) => {
    counts[item.screening.decision] = (counts[item.screening.decision] ?? 0) + 1;
    return counts;
  }, {});
  const reasonCounts = items
    .flatMap((item) => item.screening.reasonCodes)
    .reduce<Record<string, number>>((counts, reason) => {
      counts[reason] = (counts[reason] ?? 0) + 1;
      return counts;
    }, {});

  console.log("\nPilot summary:", {
    requested: limit,
    fetched: items.length,
    fetchErrors: page.listings.length - items.length,
    decisions,
    reasonCounts,
  });

  console.log(
    "Approved preview:",
    items
      .filter((item) => item.normalized)
      .slice(0, 5)
      .map((item) => ({
        id: item.normalized!.sourceListingId,
        manufacturer: item.normalized!.manufacturer,
        model: item.normalized!.model,
        year: item.normalized!.modelYear,
        mileageKm: item.normalized!.mileageKm,
        priceKrw: item.normalized!.priceKrw,
        images: item.normalized!.imageUrls.length,
      })),
  );

  if (write) {
    const result = await persistPilot(items, publish);
    console.log("Supabase write complete:", result);
  } else {
    console.log("Dry-run only: Supabase was not changed. Use --write for a private pilot import.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
