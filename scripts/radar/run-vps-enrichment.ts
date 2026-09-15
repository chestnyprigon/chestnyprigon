import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { ProxyAgent, fetch as undiciFetch } from "undici";

config({ path: ".env", quiet: true });
const runId = process.env.CHESTNY_ENRICHMENT_RUN_ID ?? "ebe8fa15-1732-4a0d-876f-b1a9a05556f7";
const batchSize = Math.min(50, Math.max(1, Number(process.env.CHESTNY_ENRICHMENT_BATCH_SIZE ?? 50)));
const delayMs = Math.max(1_000, Number(process.env.CHESTNY_ENRICHMENT_DELAY_MS ?? 3_000));
const proxyUrl = process.env.ENCAR_PROXY_URL?.trim();
const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`Missing ${name}`); return value; };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Row = { id: string; source_listing_id: string; source_url: string; candidate_snapshot: Record<string, unknown> };
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const obj = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : {};

async function main() {
  if (!proxyUrl) throw new Error("ENCAR_PROXY_URL is required; direct requests are disabled");
  const db = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: run, error: runError } = await db.from("chestny_enrichment_runs").select("status,candidate_count").eq("id", runId).single();
  if (runError) throw new Error(runError.message);
  if (!['approved','running'].includes(run.status)) throw new Error(`Run status is ${run.status}`);
  if (run.status === 'approved') await db.from("chestny_enrichment_runs").update({ status: 'running', started_at: new Date().toISOString() }).eq('id',runId);
  const { data: rows, error } = await db.rpc("claim_chestny_enrichment_queue", { p_run_id: runId, p_limit: batchSize, p_lease_minutes: 30 });
  if (error) throw new Error(error.message);
  const agent = new ProxyAgent(proxyUrl); const results: Array<Record<string, unknown>> = [];
  try {
    for (const row of (rows ?? []) as Row[]) {
      const id = text(row.candidate_snapshot.encarId) ?? row.source_listing_id;
      try {
        const get = async (url: string) => { const response = await undiciFetch(url, { headers: { Accept:'application/json', Origin:'https://fem.encar.com', Referer:'https://fem.encar.com/' }, dispatcher: agent, signal: AbortSignal.timeout(20_000) }); if (response.status === 404 || response.status === 410) throw new Error(`HTTP ${response.status}`); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); };
        const detail = obj(await get(`https://api.encar.com/v1/readside/vehicle/${encodeURIComponent(id)}`));
        const advertisement = obj(detail.advertisement); const status = text(advertisement.status) ?? text(advertisement.saleStatus);
        if (status && status !== 'ADVERTISE') { await db.rpc('complete_chestny_enrichment_queue_item',{p_queue_id:row.id,p_status:'unavailable',p_result:{encarId:id,advertisementStatus:status}}); results.push({sourceListingId:row.source_listing_id,status:'unavailable'}); continue; }
        const [inspection, summary, options] = await Promise.all([get(`https://api.encar.com/v1/readside/inspection/vehicle/${id}`).catch(()=>null),get(`https://api.encar.com/v1/readside/inspection/vehicle/${id}/summary`).catch(()=>null),get(`https://api.encar.com/v1/readside/vehicles/car/${id}/options/choice`).catch(()=>[]) ]);
        const spec=obj(detail.spec); const category=obj(detail.category); const photos=Array.isArray(detail.photos)?detail.photos.map((p)=>text(obj(p).path)).filter(Boolean).map((p)=>String(p).startsWith('http')?String(p):`https://ci.encar.com${p}`):[];
        const metadata={encarId:id,fuel:text(spec.fuelName),color:text(spec.colorName),seats:spec.seatCount??null,category:text(category.gradeEnglishName),advertisementStatus:status};
        const payload={detail,inspection,inspectionSummary:summary,choiceOptions:options,metadata,fetchedAt:new Date().toISOString()};
        const result={encarId:id,metadata,inspectionAvailable:Boolean(inspection),galleryImages:photos.length};
        const done=await db.rpc('complete_chestny_enrichment_queue_item',{p_queue_id:row.id,p_status:'succeeded',p_result:result,p_payload:payload,p_fuel:text(spec.fuelName),p_color:text(spec.colorName),p_image_urls:photos}); if(done.error) throw new Error(done.error.message);
        results.push({sourceListingId:row.source_listing_id,status:'succeeded',inspectionAvailable:Boolean(inspection),galleryImages:photos.length});
      } catch (error) { const message=error instanceof Error?error.message:String(error); const unavailable=/HTTP (404|410)/.test(message); const done=await db.rpc('complete_chestny_enrichment_queue_item',{p_queue_id:row.id,p_status:unavailable?'unavailable':'failed',p_result:{encarId:id,reason:message},p_error:unavailable?null:message}); if(done.error) throw new Error(done.error.message); results.push({sourceListingId:row.source_listing_id,status:unavailable?'unavailable':'failed',error:message}); }
      await sleep(delayMs);
    }
  } finally { await agent.close(); }
  console.log(JSON.stringify({runId,batchSize,claimed:rows?.length??0,succeeded:results.filter(r=>r.status==='succeeded').length,unavailable:results.filter(r=>r.status==='unavailable').length,failed:results.filter(r=>r.status==='failed').length,results},null,2));
}
main().catch((error)=>{console.error(error instanceof Error?error.message:error);process.exitCode=1;});
