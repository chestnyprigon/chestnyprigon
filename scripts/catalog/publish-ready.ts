import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { screenStaging } from "../encar/staging-gate";
import { CATALOG_POLICY } from "../encar/catalog-policy";
config({ path: ".env.local", quiet: true });

async function main() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase credentials missing");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const candidates = await db.from("vehicles").select("id,source_listing_id,source_url").eq("is_public", false).eq("status", "active").not("price_usd", "is", null).limit(1000);
  if (candidates.error) throw Error(candidates.error.message);
  let published = 0, isolated = 0, rejected = 0;
  for (const vehicle of candidates.data ?? []) {
    const raw = await db.from("encar_raw_listings").select("payload").eq("source_listing_id", vehicle.source_listing_id).single();
    if (raw.error) throw Error(raw.error.message);
    const bundle = raw.data.payload;
    const stage = await db.from("chestny_catalog_staging").select("*").eq("source_listing_id", String(bundle?.search?.Id ?? vehicle.source_listing_id)).maybeSingle();
    if (stage.error) throw Error(stage.error.message);
    const row = stage.data ?? { source_listing_id: bundle?.search?.Id, source_url: vehicle.source_url, candidate_snapshot: bundle?.search, encar_payload: bundle };
    const result = screenStaging(row);
    const s = result.screening;
    const saved = await db.from("listing_screening").upsert({ source_listing_id: vehicle.source_listing_id, decision: s.decision,
      is_lease: s.isLease, is_rental: s.isRental, is_taxi: s.isTaxi, is_commercial: s.isCommercial, is_problematic: s.isProblematic,
      reason_codes: s.reasonCodes, rules_version: s.rulesVersion, screened_at: new Date().toISOString(),
      details: { evidence: s.reasonEvidence, publicationGate: result.proof, policy: CATALOG_POLICY } });
    if (saved.error) throw Error(saved.error.message);
    if (s.decision !== "approved") { if (s.decision === "isolated") isolated++; else rejected++; continue; }
    // The DB guard independently requires five stored images, confirmed report outcome and current proof.
    const update = await db.from("vehicles").update({ is_public: true }).eq("id", vehicle.id);
    if (update.error) throw Error(update.error.message);
    published++;
  }
  console.log(JSON.stringify({ candidates: candidates.data?.length ?? 0, published, isolated, rejected }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
