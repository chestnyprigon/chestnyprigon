import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import { publicationGate, isolate } from "../encar/publication-gate";
import { evidence } from "../encar/catalog-policy";
import { stagingPublicationInput } from "../encar/staging-gate";
import type { EncarBundle } from "../encar/types";
config({path:".env.local",quiet:true});

async function main() {
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !url.includes("ojnybjomttolhsfgkdqq")) throw Error("Expected chestny-prigon project");
  const db=createClient(url,key); const apply=process.argv.includes("--apply");
  const candidates=await db.from("listing_screening").select("source_listing_id,reason_codes").eq("decision","isolated").eq("rules_version","2026-10-07.1").eq("details->>legacyDecision","manual_review");
  if(candidates.error) throw Error(candidates.error.message);
  const results=[];
  for (const candidate of candidates.data??[]) {
    const raw=await db.from("encar_raw_listings").select("payload,source_url").eq("source_listing_id",candidate.source_listing_id).single();
    if(raw.error) throw Error(`raw ${candidate.source_listing_id}: ${raw.error.message}`);
    const original=raw.data.payload as Partial<EncarBundle>;
    const incomplete=!original.search || !original.detail;
    const bundle: EncarBundle={fetchedAt:original.fetchedAt??"",search:original.search??{Id:candidate.source_listing_id},detail:original.detail??{}};
    const stage=await db.from("chestny_catalog_staging").select("*").eq("source_listing_id",String(bundle.search?.Id??candidate.source_listing_id)).maybeSingle();
    if(stage.error) throw Error(`stage ${candidate.source_listing_id}: ${stage.error.message}`);
    const input=stage.data?stagingPublicationInput(stage.data):{bundle,sourceUrl:raw.data.source_url??""};
    const gate=publicationGate(input);
    const vehicle=await db.from("vehicles").select("source_listing_id,manufacturer,model,model_year,mileage_km,engine_cc,fuel_type,transmission,price_krw").eq("source_listing_id",candidate.source_listing_id).maybeSingle();
    if(vehicle.error) throw Error(`vehicle ${candidate.source_listing_id}: ${vehicle.error.message}`);
    if(vehicle.data) {
      const v=vehicle.data;
      const checked=publicationGate({...input,expectedVehicle:{sourceListingId:v.source_listing_id,manufacturer:v.manufacturer,model:v.model,modelYear:v.model_year,mileageKm:v.mileage_km,engineCc:v.engine_cc,fuelType:v.fuel_type,transmission:v.transmission,priceKrw:Number(v.price_krw)}});
      gate.screening=checked.screening;gate.proof=checked.proof;
    }
    if (incomplete) gate.screening=isolate(gate.screening,[evidence("legacy_payload_incomplete","Старый payload не содержит исходных search/detail для машинной проверки.",{sourceId:candidate.source_listing_id},"encar_raw_listings.payload")]);
    const s=gate.screening;
    if(apply) {
      const saved=await db.from("listing_screening").update({decision:s.decision,is_lease:s.isLease,is_rental:s.isRental,is_taxi:s.isTaxi,is_commercial:s.isCommercial,is_problematic:s.isProblematic,
        reason_codes:s.reasonCodes,rules_version:s.rulesVersion,screened_at:new Date().toISOString(),details:{evidence:s.reasonEvidence,publicationGate:gate.proof,previousDecision:{decision:"manual_review",reasonCodes:candidate.reason_codes}}}).eq("source_listing_id",candidate.source_listing_id);
      if(saved.error) throw Error(saved.error.message);
    }
    results.push({sourceId:candidate.source_listing_id,decision:s.decision,evidence:s.reasonEvidence});
  }
  await mkdir("output",{recursive:true});await writeFile("output/legacy-rescreen-results.json",JSON.stringify({apply,results},null,2)+"\n");
  console.log(JSON.stringify({apply,count:results.length,decisions:results.reduce((a,r)=>(a[r.decision]=(a[r.decision]??0)+1,a),{} as Record<string,number>)}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
