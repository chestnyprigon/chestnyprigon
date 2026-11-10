import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { normalizeMobileDeField, normalizeMobileDeOptions } from "@/lib/mobile-de/localization";

loadEnv({ path: ".env.local", quiet: true });

const cohort = "customer_europe_2026";
const version = "mobile-de-de-ru/2026-11-10.1";
const write = process.argv.includes("--write");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Supabase credentials are missing from .env.local");

const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
type Listing = {
  master_id: string;
  source_id: string;
  customer_cohort: string;
  drive: string | null;
  body_type: string | null;
  color: string | null;
  options: unknown;
  source_payload: unknown;
};

async function loadCohort() {
  const rows: Listing[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await supabase.from("mobile_de_catalog_listings")
      .select("master_id,source_id,customer_cohort,drive,body_type,color,options,source_payload")
      .eq("customer_cohort", cohort).order("master_id").range(from, from + 499);
    if (error) throw error;
    rows.push(...(data as Listing[]));
    if (data.length < 500) break;
  }
  if (rows.length !== 3_872 || new Set(rows.map((row) => row.master_id)).size !== 3_872) {
    throw new Error(`Expected exactly 3,872 unique rows in ${cohort}; got ${rows.length}`);
  }
  return rows;
}

function payloadObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function main() {
  const rows = await loadCohort();
  const changes = rows.flatMap((row) => {
    const next = {
      drive: normalizeMobileDeField(row.drive, "drive"),
      body_type: normalizeMobileDeField(row.body_type, "body"),
      color: normalizeMobileDeField(row.color, "color"),
      options: normalizeMobileDeOptions(row.options),
    };
    const before = { drive: row.drive, body_type: row.body_type, color: row.color, options: row.options };
    const changed = JSON.stringify(before) !== JSON.stringify(next);
    if (!changed) return [];
    const sourcePayload = payloadObject(row.source_payload);
    const localization = payloadObject(sourcePayload.presentation_normalization);
    const update = {
      ...next,
      source_payload: {
        ...sourcePayload,
        presentation_normalization: {
          ...localization,
          version,
          original_values: localization.original_values ?? before,
        },
      },
    };
    return [{ row, before, update }];
  });

  const summary = {
    mode: write ? "write" : "dry-run",
    cohort,
    total: rows.length,
    changed: changes.length,
    normalizedOptions: changes.reduce((sum, item) => sum + (Array.isArray(item.update.options) ? item.update.options.length : 0), 0),
    remainingGermanFieldValues: rows.flatMap((row) => {
      const body = normalizeMobileDeField(row.body_type, "body");
      const drive = normalizeMobileDeField(row.drive, "drive");
      const color = normalizeMobileDeField(row.color, "color");
      return [body, drive, color].filter((value) => value && /[äöüß]/i.test(value));
    }).length,
  };
  console.log(JSON.stringify(summary));
  if (!write) return;

  let updated = 0;
  for (let start = 0; start < changes.length; start += 5) {
    const chunk = changes.slice(start, start + 5);
    const results = await Promise.all(chunk.map(async ({ row, update }) => {
      const { data, error } = await supabase.from("mobile_de_catalog_listings")
        .update(update).eq("master_id", row.master_id).eq("customer_cohort", cohort)
        .select("master_id");
      if (error) throw new Error(`Failed to update source_id ${row.source_id}: ${error.message}`);
      if (data?.length !== 1) throw new Error(`Update matched ${data?.length ?? 0} rows for source_id ${row.source_id}`);
      return true;
    }));
    updated += results.length;
    if (updated % 100 === 0 || updated === changes.length) console.log(`updated ${updated}/${changes.length}`);
  }
  console.log(JSON.stringify({ result: "complete", updated, cohort, version }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
