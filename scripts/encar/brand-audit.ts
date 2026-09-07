import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { config as loadEnvironment } from "dotenv";
import { createDomesticQuery, delay, fetchBundle, fetchSearchPage } from "./client";
import { ENCAR_MAX_MILEAGE_KM } from "./config";
import { normalizeListing } from "./normalize";
import { screenListing } from "./screening";
import type { EncarSearchListing } from "./types";
import { manufacturerAliases } from "./manufacturer-aliases";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

type BrandTarget = { brand: string; sourceManufacturer: string; group: "core" | "premium" | "other" };

// These are source-side names. The resulting report uses the canonical names
// already used by the catalogue, so this audit also exposes alias gaps.
const TARGETS: readonly BrandTarget[] = [
  { brand: "Hyundai", sourceManufacturer: "현대", group: "core" },
  { brand: "Kia", sourceManufacturer: "기아", group: "core" },
  { brand: "Genesis", sourceManufacturer: "제네시스", group: "core" },
  { brand: "BMW", sourceManufacturer: "BMW", group: "core" },
  { brand: "Mercedes-Benz", sourceManufacturer: "벤츠", group: "core" },
  { brand: "Audi", sourceManufacturer: "아우디", group: "core" },
  { brand: "Toyota", sourceManufacturer: "도요타", group: "core" },
  { brand: "Lexus", sourceManufacturer: "렉서스", group: "core" },
  { brand: "Volkswagen", sourceManufacturer: "폭스바겐", group: "core" },
  { brand: "Volvo", sourceManufacturer: "볼보", group: "core" },
  { brand: "Land Rover", sourceManufacturer: "랜드로버", group: "premium" },
  { brand: "Porsche", sourceManufacturer: "포르쉐", group: "premium" },
  { brand: "Nissan", sourceManufacturer: "닛산", group: "other" },
  { brand: "Honda", sourceManufacturer: "혼다", group: "other" },
  { brand: "Mazda", sourceManufacturer: "마쯔다", group: "other" },
  { brand: "Subaru", sourceManufacturer: "스바루", group: "other" },
  { brand: "Chevrolet", sourceManufacturer: "쉐보레", group: "other" },
  { brand: "Mitsubishi", sourceManufacturer: "미쓰비시", group: "other" },
  { brand: "Ford", sourceManufacturer: "포드", group: "other" },
  { brand: "Jeep", sourceManufacturer: "지프", group: "other" },
  { brand: "Renault Korea", sourceManufacturer: "르노", group: "other" },
  { brand: "KGM", sourceManufacturer: "쌍용", group: "other" },
  { brand: "MINI", sourceManufacturer: "미니", group: "premium" },
  { brand: "Jaguar", sourceManufacturer: "재규어", group: "premium" },
  { brand: "Peugeot", sourceManufacturer: "푸조", group: "other" },
];

function integerArgument(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function stringArgument(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
}

function selectedTargets() {
  const requested = stringArgument("brands");
  if (!requested) return TARGETS;
  const names = new Set(requested.split(",").map((value) => value.trim()).filter(Boolean));
  const targets = TARGETS.filter((target) => names.has(target.brand));
  if (!targets.length) throw new Error(`No matching brands. Supported: ${TARGETS.map((target) => target.brand).join(", ")}`);
  return targets;
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function modelYear(listing: EncarSearchListing) {
  const encoded = finiteNumber(listing.Year);
  if (encoded !== null && encoded >= 190000) return Math.floor(encoded / 100);
  return finiteNumber(listing.FormYear);
}

function increment(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

async function main() {
  const sampleSize = integerArgument("sample-size", 100, 10, 100);
  const yearFrom = integerArgument("year-from", 2016, 1990, new Date().getFullYear());
  const yearTo = integerArgument("year-to", new Date().getFullYear(), yearFrom, new Date().getFullYear() + 1);
  const detailDelayMs = integerArgument("detail-delay-ms", 900, 500, 30_000);
  const targets = selectedTargets();
  const results: Array<Record<string, unknown>> = [];
  const output = stringArgument("output") ?? path.resolve(process.cwd(), "output/encar-brand-audit.json");

  async function checkpoint() {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), readOnly: true, completedBrands: results.length, results }, null, 2));
  }

  console.log(JSON.stringify({
    status: "started",
    readOnly: true,
    directLocal: !process.env.ENCAR_PROXY_URL?.trim(),
    brands: targets.length,
    sampleSize,
    yearFrom,
    yearTo,
    maxMileageKm: ENCAR_MAX_MILEAGE_KM,
  }));

  for (const target of targets) {
    const startedAt = Date.now();
    const aliases = manufacturerAliases(target.brand);
    const aliasPages = await Promise.all(aliases.map((sourceManufacturer) =>
      fetchSearchPage({
        offset: 0,
        limit: sampleSize,
        query: createDomesticQuery(yearFrom, yearTo, ENCAR_MAX_MILEAGE_KM, "Y", sourceManufacturer, 300, 50_000),
      }),
    ));
    const listings = [...new Map(aliasPages.flatMap((page) => page.listings).map((listing) => [String(listing.Id), listing])).values()].slice(0, sampleSize);
    const sourceTotal = aliasPages.reduce((total, page) => total + page.total, 0);
    const decisions: Record<string, number> = {};
    const reasons: Record<string, number> = {};
    const models = new Set<string>();
    const ids = new Set<string>();
    const years: number[] = [];
    const prices: number[] = [];
    let fetchErrors = 0;

    console.log(`[${target.brand}] sourceAliases=${aliases.join("|")} sourceTotal=${sourceTotal} sampling=${listings.length}`);
    for (const [index, listing] of listings.entries()) {
      try {
        const bundle = await fetchBundle(listing);
        const screening = screenListing(bundle);
        increment(decisions, screening.decision);
        for (const reason of screening.reasonCodes) increment(reasons, reason);
        ids.add(String(listing.Id));
        if (listing.Model) models.add(String(listing.Model));
        const year = modelYear(listing);
        const price = finiteNumber(listing.Price);
        if (year !== null) years.push(year);
        if (price !== null && price > 0) prices.push(price * 10_000);
        // Exercise the same normalizer used by the intake and catch source
        // fields that pass screening but cannot be represented in our schema.
        if (screening.decision === "approved") normalizeListing(bundle);
      } catch (error) {
        fetchErrors += 1;
        increment(reasons, "fetch_error");
        console.error(`[${target.brand}] ${index + 1}/${listings.length} failed:`, error instanceof Error ? error.message : error);
      }
      if (index < listings.length - 1) await delay(detailDelayMs);
    }

    const summary = {
      brand: target.brand,
      sourceManufacturers: aliases,
      group: target.group,
      sourceTotal,
      sampled: listings.length,
      uniqueIds: ids.size,
      uniqueModels: models.size,
      decisions,
      reasonCounts: reasons,
      fetchErrors,
      yearRange: years.length ? { min: Math.min(...years), max: Math.max(...years) } : null,
      priceKrwRange: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
    };
    results.push(summary);
    await checkpoint();
    console.log(JSON.stringify(summary));
  }

  await checkpoint();

  console.log(JSON.stringify({
    status: "completed",
    readOnly: true,
    brands: results.length,
    output,
    sourceTotals: results.reduce((total, result) => total + Number(result.sourceTotal ?? 0), 0),
    sampled: results.reduce((total, result) => total + Number(result.sampled ?? 0), 0),
    approved: results.reduce((total, result) => total + Number((result.decisions as Record<string, number>)?.approved ?? 0), 0),
    manualReview: results.reduce((total, result) => total + Number((result.decisions as Record<string, number>)?.manual_review ?? 0), 0),
    rejected: results.reduce((total, result) => total + Number((result.decisions as Record<string, number>)?.rejected ?? 0), 0),
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
