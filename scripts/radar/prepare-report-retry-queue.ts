import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local", quiet: true });

const sourceRunId = process.env.CHESTNY_REPORT_RETRY_SOURCE_RUN_ID ?? "ebe8fa15-1732-4a0d-876f-b1a9a05556f7";
const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`Missing environment variable ${name}`); return value; };

async function main() {
  const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const stagingRows: Array<{ source_listing_id: string }> = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.from("chestny_catalog_staging")
      .select("source_listing_id")
      .eq("report_status", "unavailable")
      .eq("enrichment_status", "succeeded")
      .order("source_listing_id")
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    stagingRows.push(...((data ?? []) as Array<{ source_listing_id: string }>));
    if (!data || data.length < 1000) break;
  }
  const ids = [...new Set(stagingRows.map((row) => row.source_listing_id).filter(Boolean))];
  if (!ids.length) throw new Error("No eligible unavailable reports found in staging");
  const sourceRows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const { data, error } = await db.from("chestny_enrichment_queue")
      .select("source_listing_id,source_url,candidate_snapshot")
      .eq("run_id", sourceRunId).in("source_listing_id", ids.slice(offset, offset + 500));
    if (error) throw new Error(error.message);
    sourceRows.push(...((data ?? []) as Array<Record<string, unknown>>));
  }
  if (sourceRows.length !== ids.length) throw new Error(`Source queue mismatch: staging=${ids.length}, queue=${sourceRows.length}`);
  const { data: run, error: runError } = await db.from("chestny_enrichment_runs").insert({
    project: "chestny-prigon", status: "awaiting_approval", candidate_count: sourceRows.length,
    source_file: `database:${sourceRunId}:report_status=unavailable`,
    rules: { type: "report_retry", sourceRunId, requests: ["inspection", "summary"], excluded: ["detail", "options", "gallery"] },
  }).select("id,status,candidate_count").single();
  if (runError) throw new Error(runError.message);
  for (let offset = 0; offset < sourceRows.length; offset += 500) {
    const batch = sourceRows.slice(offset, offset + 500).map((row) => ({ run_id: run.id, source_listing_id: String(row.source_listing_id), source_url: row.source_url, candidate_snapshot: row.candidate_snapshot }));
    const { error } = await db.from("chestny_enrichment_queue").insert(batch);
    if (error) throw new Error(error.message);
  }
  console.log(JSON.stringify({ status: "awaiting_approval", run, sourceRunId, selected: sourceRows.length, queued: sourceRows.length, encarRequests: 0, published: 0 }, null, 2));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
