import fs from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const candidateFile = path.resolve(process.cwd(), "output/radar-local-candidates.json");
const project = "chestny-prigon";
const sourceFile = "output/radar-local-candidates.json";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

async function main() {
  const document = JSON.parse(await fs.readFile(candidateFile, "utf8")) as {
    candidates?: Array<Record<string, unknown>>;
    summary?: Record<string, unknown>;
    rules?: Record<string, unknown>;
  };
  const candidates = document.candidates ?? [];
  if (candidates.length !== 1606) throw new Error(`Expected 1606 candidates, got ${candidates.length}`);
  const ids = candidates.map((candidate) => String(candidate.sourceListingId ?? ""));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("Candidate IDs must be non-empty and unique");

  const supabase = createClient(required("RADAR_SUPABASE_URL"), required("RADAR_SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: run, error: runError } = await supabase.from("chestny_enrichment_runs").insert({
    project,
    status: "awaiting_approval",
    candidate_count: candidates.length,
    source_file: sourceFile,
    rules: document.rules ?? {},
  }).select("id,status,candidate_count").single();
  if (runError) throw new Error(runError.message);

  for (let offset = 0; offset < candidates.length; offset += 500) {
    const batch = candidates.slice(offset, offset + 500).map((candidate) => ({
      run_id: run.id,
      source_listing_id: String(candidate.sourceListingId),
      source_url: `https://www.encar.com/dc/dc_cardetailview.do?carid=${encodeURIComponent(String(candidate.sourceListingId))}`,
      candidate_snapshot: candidate,
    }));
    const { error } = await supabase.from("chestny_enrichment_queue").insert(batch);
    if (error) throw new Error(error.message);
  }
  console.log(JSON.stringify({ status: "awaiting_approval", project, run, queued: candidates.length, writes: true, encarRequests: 0, published: 0 }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
