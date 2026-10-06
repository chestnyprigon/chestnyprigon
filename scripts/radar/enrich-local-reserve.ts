import fs from "node:fs/promises";
import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { fetchPublicDetail, delay } from "../encar/client";
import { normalizeListing } from "../encar/normalize";
import { screenListing } from "../encar/screening";
import { persistPilot } from "../encar/persistence";
import type { EncarBundle, EncarSearchListing, PilotItem } from "../encar/types";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

function argument(name: string, fallback: number, min: number, max: number) {
  const raw = process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${name} must be an integer from ${min} to ${max}`);
  return value;
}

async function main() {
  if (process.env.ENCAR_PROXY_URL?.trim()) throw new Error("Local-only rule violated: ENCAR_PROXY_URL is set");
  const limit = argument("limit", 100, 1, 100);
  const offset = argument("offset", 0, 0, 5_000);
  const delayMs = argument("delay-ms", 2_000, 1_000, 10_000);
  const candidateFile = process.argv.find((value) => value.startsWith("--candidate-file="))?.slice("--candidate-file=".length);
  const reportPath = path.resolve(process.cwd(), candidateFile ?? "output/radar-local-candidates.json");
  const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as { candidates?: Array<Record<string, unknown>> };
  const candidates = (report.candidates ?? []).slice(offset, offset + limit);
  if (!candidates.length) throw new Error("No candidates in the requested range");

  const items: PilotItem[] = [];
  let errors = 0;
  let missing = 0;
  let rejected = 0;
  let isolated = 0;
  for (const candidate of candidates) {
    const id = String(candidate.sourceListingId ?? "");
    try {
      const listing: EncarSearchListing = {
        Id: id,
        Manufacturer: String(candidate.manufacturer ?? ""),
        Model: String(candidate.model ?? ""),
        Year: Number(candidate.modelYear ?? 0) * 100,
        FormYear: Number(candidate.modelYear ?? 0),
        Mileage: Number(candidate.mileageKm ?? 0),
        Price: Math.round(Number(candidate.priceKrw ?? 0) / 10_000),
        Photos: [],
        SellType: "일반",
      };
      const bundle: EncarBundle = { fetchedAt: new Date().toISOString(), search: listing, detail: await fetchPublicDetail(id, { attempts: 1, timeoutMs: 20_000 }) };
      const screening = screenListing(bundle);
      if (screening.decision === "rejected") rejected += 1;
      if (screening.decision === "isolated") isolated += 1;
      items.push({ bundle, screening, normalized: screening.decision === "approved" ? normalizeListing(bundle) : null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("HTTP 404")) missing += 1;
      else {
        errors += 1;
        console.error(`fetch_error ${id}:`, message);
      }
    }
    await delay(delayMs);
  }

  const persisted = items.length ? await persistPilot(items, false, { source: "radar-local-reserve", offset, requested: candidates.length, publish: false }) : null;
  console.log(JSON.stringify({ status: "completed", mode: "local-only", requested: candidates.length, fetched: items.length, approved: items.filter((item) => item.screening.decision === "approved").length, isolated, rejected, missing, errors, persisted }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
