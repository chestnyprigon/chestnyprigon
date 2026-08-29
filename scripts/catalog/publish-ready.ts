import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

async function main() {
  const client = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const candidates: Array<{ id: string; source_listing_id: string }> = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await client
      .from("vehicles")
      .select("id,source_listing_id")
      .eq("status", "active")
      .eq("is_public", false)
      .not("price_usd", "is", null)
      .or("revalidation_miss_count.is.null,revalidation_miss_count.eq.0")
      .order("published_at", { ascending: true, nullsFirst: true })
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    candidates.push(...(data ?? []));
    if ((data?.length ?? 0) < 1_000) break;
  }

  const reportReady = new Set<string>();
  const approved = new Set<string>();
  const withImages = new Set<string>();
  for (let offset = 0; offset < candidates.length; offset += 200) {
    const ids = candidates.slice(offset, offset + 200).map((item) => item.id);
    const { data: reports, error: reportError } = await client
      .from("vehicle_reports")
      .select("vehicle_id")
      .in("vehicle_id", ids)
      .eq("report_status", "ready");
    if (reportError) throw new Error(reportError.message);
    for (const row of reports ?? []) reportReady.add(row.vehicle_id);

    const sourceIds = candidates.slice(offset, offset + 200).map((item) => item.source_listing_id);
    const { data: screening, error: screeningError } = await client
      .from("listing_screening")
      .select("source_listing_id")
      .in("source_listing_id", sourceIds)
      .eq("decision", "approved");
    if (screeningError) throw new Error(screeningError.message);
    for (const row of screening ?? []) approved.add(row.source_listing_id);

    const { data: images, error: imageError } = await client
      .from("vehicle_images")
      .select("vehicle_id")
      .in("vehicle_id", ids);
    if (imageError) throw new Error(imageError.message);
    for (const row of images ?? []) withImages.add(row.vehicle_id);
  }

  const ready = candidates.filter((vehicle) =>
    reportReady.has(vehicle.id) && approved.has(vehicle.source_listing_id) && withImages.has(vehicle.id),
  );
  const selected = ready.slice(0, 1_000);
  for (let offset = 0; offset < selected.length; offset += 200) {
    const { error } = await client
      .from("vehicles")
      .update({ is_public: true })
      .in("id", selected.slice(offset, offset + 200).map((vehicle) => vehicle.id));
    if (error) throw new Error(error.message);
  }
  console.log({ candidates: candidates.length, qualityApproved: ready.length, published: selected.length });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
