import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { writeFile, mkdir } from "node:fs/promises";
import { CATALOG_POLICY } from "../encar/catalog-policy";
import { APPROVED_BRAND_QUOTAS } from "./brand-quotas";
config({path:".env.local",quiet:true});

async function main() {
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL, key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !url.includes("ojnybjomttolhsfgkdqq")) throw Error("Expected chestny-prigon Supabase project");
  if (APPROVED_BRAND_QUOTAS.reduce((s,q)=>s+q.target,0)!==1000) throw Error("Quota sum must be 1000");
  const db=createClient(url,key);
  const name="local-catalog-1000-20261007";
  let launch=await db.from("chestny_catalog_launches").select("*").eq("name",name).maybeSingle();
  if (launch.error) throw Error(launch.error.message);
  if (!launch.data && process.argv.includes("--apply")) {
    const prepared=await db.rpc("prepare_chestny_catalog_launch",{p_name:name,p_quotas:APPROVED_BRAND_QUOTAS,p_rules:CATALOG_POLICY});
    if (prepared.error) throw Error(prepared.error.message);
    launch=await db.from("chestny_catalog_launches").select("*").eq("id",prepared.data).single();
    if (launch.error) throw Error(launch.error.message);
  }
  if (!launch.data) throw Error("No launch yet: run with --apply to freeze the baseline");
  if (launch.data.status === "capturing" && process.argv.includes("--apply")) {
    let inserted = 0;
    const collect = async (table: string, column: string) => {
      let from = 0;
      for (;;) {
        const page = await db.from(table).select(column).not(column,"is",null).order(column).range(from,from+999);
        if (page.error) throw Error(`${table}: ${page.error.message}`);
        const data = page.data as unknown as Array<Record<string,unknown>> | null;
        if (!data?.length) break;
        const rows = data.map((row) => ({launch_id:launch.data!.id,source_identifier:String(row[column])}));
        const saved = await db.from("chestny_catalog_launch_baseline_identifiers").upsert(rows,{onConflict:"launch_id,source_identifier",ignoreDuplicates:true});
        if (saved.error) throw Error(`baseline ${table}: ${saved.error.message}`);
        inserted += rows.length;
        from += data.length;
        if (data.length < 1000) break;
      }
    };
    for (const [table,column] of [
      ["vehicles","source_listing_id"],
      ["vehicle_source_identifiers","source_identifier"],
      ["encar_raw_listings","source_listing_id"],
      ["chestny_catalog_staging","source_listing_id"],
      ["chestny_enrichment_queue","source_listing_id"],
    ]) await collect(table,column);
    const count=await db.from("chestny_catalog_launch_baseline_identifiers").select("source_identifier",{count:"exact",head:true}).eq("launch_id",launch.data.id);
    if(count.error) throw Error(count.error.message);
    if(!count.count) throw Error("Baseline identifier snapshot is empty");
    const finalized=await db.rpc("finalize_chestny_catalog_baseline",{p_launch:launch.data.id});
    if(finalized.error) throw Error(finalized.error.message);
    launch=await db.from("chestny_catalog_launches").select("*").eq("id",launch.data.id).single();
    if(launch.error) throw Error(launch.error.message);
    console.log(JSON.stringify({baselineIdentifiers:count.count,upsertedRows:inserted}));
  }
  if (launch.data.status !== "prepared" && launch.data.status !== "running") throw Error(`Launch is ${launch.data.status}; publication cannot start`);
  const progress=await db.from("chestny_catalog_launch_progress").select("*").eq("launch_id",launch.data.id);
  if (progress.error) throw Error(progress.error.message);
  const output={launch:launch.data,progress:progress.data};
  await mkdir("output",{recursive:true});await writeFile("output/local-catalog-launch.json",JSON.stringify(output,null,2)+"\n");
  console.log(JSON.stringify(output,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
