import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { canonicalSourceId } from "./identity";
import type { PilotItem } from "./types";
import { calculateBelarusPrice, CHESTNY_PRIGON_PRICING_PROFILE } from "../../src/lib/pricing/chestny-prigon-profile";

function requireEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function adminClient(): SupabaseClient {
  return createClient(
    requireEnvironment("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

function payloadHash(payload: PilotItem["bundle"]) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function checked<T>(promise: PromiseLike<{ data: T; error: { message: string } | null }>) {
  const result = await promise;
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

export async function persistPilot(items: PilotItem[], publish: boolean) {
  const supabase = adminClient();
  const uniqueItems = [
    ...new Map(items.map((item) => [canonicalSourceId(item.bundle), item])).values(),
  ];
  const run = await checked(
    supabase
      .from("import_runs")
      .insert({ mode: "initial", status: "running", cursor: { pilot: true, publish } })
      .select("id")
      .single(),
  );
  const runId = (run as { id: string }).id;
  // Unsupported powertrains are intentionally not persisted, including raw payloads.
  // The client confirmed that hybrids are accepted and calculated by ICE displacement;
  // pure EV and hydrogen listings wait for a separate customs rule.
  const persistableItems = uniqueItems.filter((item) => !item.screening.isUnsupportedPowertrain);
  const approvedItems = persistableItems.filter(
    (item) => item.screening.decision === "approved" && item.normalized,
  );
  const rejectedCount = uniqueItems.length - approvedItems.length;

  try {
    await checked(
      supabase.from("encar_raw_listings").upsert(
        persistableItems.map((item) => {
          const sourceListingId = canonicalSourceId(item.bundle);
          const advertisedListingId = String(item.bundle.search.Id);
          return {
            source_listing_id: sourceListingId,
            import_run_id: runId,
            source_url: `https://www.encar.com/dc/dc_cardetailview.do?carid=${advertisedListingId}`,
            payload: item.bundle,
            payload_hash: payloadHash(item.bundle),
            last_seen_at: item.bundle.fetchedAt,
            processed_at: new Date().toISOString(),
          };
        }),
        { onConflict: "source_listing_id" },
      ),
    );

    await checked(
      supabase.from("listing_screening").upsert(
        persistableItems.map((item) => ({
          source_listing_id: canonicalSourceId(item.bundle),
          decision: item.screening.decision,
          is_lease: item.screening.isLease,
          is_rental: item.screening.isRental,
          is_taxi: item.screening.isTaxi,
          is_commercial: item.screening.isCommercial,
          is_problematic: item.screening.isProblematic,
          reason_codes: item.screening.reasonCodes,
          rules_version: item.screening.rulesVersion,
          details: { matchedTerms: item.screening.matchedTerms },
        })),
        { onConflict: "source_listing_id" },
      ),
    );

    let storedVehicles: Array<{ id: string; source_listing_id: string }> = [];
    if (approvedItems.length) {
      storedVehicles = (await checked(
        supabase
          .from("vehicles")
          .upsert(
            approvedItems.map((item) => {
              const vehicle = item.normalized!;
              // Store the same calculation used by the public catalogue at
              // ingestion time. Without it a newly accepted hybrid receives
              // a null price and gets excluded by price-range queries until a
              // separate maintenance task happens to run.
              const calculation = calculateBelarusPrice({
                priceKrw: vehicle.priceKrw,
                engineCc: vehicle.engineCc,
                firstRegistrationDate: vehicle.firstRegistrationDate,
                fuelType: vehicle.fuelType,
                preferential: false,
              });
              return {
                source_listing_id: vehicle.sourceListingId,
                manufacturer: vehicle.manufacturer,
                model: vehicle.model,
                generation: vehicle.generation,
                trim: vehicle.trim,
                model_year: vehicle.modelYear,
                first_registration_date: vehicle.firstRegistrationDate,
                mileage_km: vehicle.mileageKm,
                price_krw: vehicle.priceKrw,
                price_usd: calculation.totalUsd,
                krw_per_usd: CHESTNY_PRIGON_PRICING_PROFILE.krwPerUsd,
                engine_cc: vehicle.engineCc,
                fuel_type: vehicle.fuelType,
                transmission: vehicle.transmission,
                drive_type: vehicle.driveType,
                body_type: vehicle.bodyType,
                exterior_color: vehicle.exteriorColor,
                location: vehicle.location,
                vin_masked: vehicle.vinMasked,
                status: "active",
                ...(publish ? { is_public: true } : {}),
                source_url: vehicle.sourceUrl,
                source_updated_at: vehicle.sourceUpdatedAt,
                last_seen_at: item.bundle.fetchedAt,
              };
            }),
            { onConflict: "source_listing_id" },
          )
          .select("id,source_listing_id"),
      )) as Array<{ id: string; source_listing_id: string }>;

      const vehicleIds = storedVehicles.map((vehicle) => vehicle.id);
      await checked(supabase.from("vehicle_images").delete().in("vehicle_id", vehicleIds));
      const idBySource = new Map(
        storedVehicles.map((vehicle) => [vehicle.source_listing_id, vehicle.id]),
      );
      const imageRows = approvedItems.flatMap((item) => {
        const vehicle = item.normalized!;
        const vehicleId = idBySource.get(vehicle.sourceListingId);
        if (!vehicleId) return [];
        return vehicle.imageUrls.map((sourceUrl, position) => ({
          vehicle_id: vehicleId,
          source_url: sourceUrl,
          position,
        }));
      });

      for (let offset = 0; offset < imageRows.length; offset += 500) {
        await checked(supabase.from("vehicle_images").insert(imageRows.slice(offset, offset + 500)));
      }
    }

    await checked(
      supabase
        .from("import_runs")
        .update({
          status: "completed",
          finished_at: new Date().toISOString(),
          fetched_count: uniqueItems.length,
          accepted_count: storedVehicles.length,
          rejected_count: rejectedCount,
          error_count: 0,
        })
        .eq("id", runId),
    );
  } catch (error) {
    await supabase
      .from("import_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_count: 1,
        error_summary: [error instanceof Error ? error.message : String(error)],
      })
      .eq("id", runId);
    throw error;
  }

  return {
    runId,
    fetchedCount: uniqueItems.length,
    acceptedCount: approvedItems.length,
    rejectedCount,
    errorCount: 0,
    published: publish,
  };
}
