import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { canonicalSourceId, sourceIdentifiers } from "./identity";
import type { PilotItem } from "./types";
import { calculateBelarusPrice, FALLBACK_EXCHANGE_RATES } from "../../src/lib/pricing/chestny-prigon-profile";
import { fetchNbrbRates } from "../../src/lib/pricing/nbrb-rates";
import { loadPersistedPricingProfile } from "../pricing/load-profile";
import { publicationGate } from "./publication-gate";
import { CATALOG_POLICY } from "./catalog-policy";
import { evidence } from "./catalog-policy";
import { accidentSummary, inspectionSummary } from "./enrich";

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

export async function persistPilot(
  items: PilotItem[],
  publish: boolean,
  runCursor: Record<string, unknown> = { pilot: true, publish },
) {
  const supabase = adminClient();
  async function recordCollision(item: PilotItem, sourceIdentifier: string, expected: unknown, actual: unknown) {
    const e = evidence("identity_source_identifier_collision", "Идентификатор уже принадлежит другой карточке; публикация изолирована.", { sourceIdentifier, expected, actual }, "vehicle_source_identifiers / publication batch");
    await checked(supabase.from("chestny_catalog_decisions").upsert({ source_listing_id: String(item.bundle.search.Id),
      decision: "isolated", rules_version: CATALOG_POLICY.version, evidence: [e], proof: { validated: false }, decided_at: e.observedAt }));
  }
  const proofs = new Map<string, ReturnType<typeof publicationGate>>();
  if (publish) items = items.map(item => {
    const result = publicationGate({ bundle: item.bundle, sourceUrl: item.normalized?.sourceUrl ?? "", ...item.enrichment });
    proofs.set(canonicalSourceId(item.bundle), result);
    return { ...item, screening: result.screening, normalized: result.normalized };
  });
  const owners = new Map<string, string>();
  for (const item of items) for (const id of sourceIdentifiers(item.bundle)) {
    if (!id.value) continue;
    const canonical = canonicalSourceId(item.bundle);
    if (owners.has(id.value) && owners.get(id.value) !== canonical) {
      await recordCollision(item, id.value, canonical, owners.get(id.value));
      throw new Error(`identity_batch_collision:${id.value}`);
    }
    owners.set(id.value, canonical);
  }
  for (let offset = 0; offset < owners.size; offset += 200) {
    const ids = [...owners.keys()].slice(offset, offset + 200);
    const links = await checked(supabase.from("vehicle_source_identifiers").select("source_identifier,vehicle_id,vehicles!inner(source_listing_id)").in("source_identifier", ids));
    for (const link of links ?? []) {
      const vehicle = link.vehicles as unknown as { source_listing_id: string };
      if (vehicle.source_listing_id !== owners.get(link.source_identifier)) {
        const item = items.find(candidate => sourceIdentifiers(candidate.bundle).some(id => id.value === link.source_identifier))!;
        await recordCollision(item, link.source_identifier, owners.get(link.source_identifier), vehicle.source_listing_id);
        throw new Error(`identity_source_identifier_collision:${link.source_identifier}`);
      }
    }
  }
  const profile = await loadPersistedPricingProfile(supabase);
  const exchangeRates = await fetchNbrbRates().catch(() => FALLBACK_EXCHANGE_RATES);
  const uniqueItems = [
    ...new Map(items.map((item) => [canonicalSourceId(item.bundle), item])).values(),
  ];
  const run = await checked(
    supabase
      .from("import_runs")
      .insert({ mode: "initial", status: "running", cursor: runCursor })
      .select("id")
      .single(),
  );
  const runId = (run as { id: string }).id;
  // Unsupported powertrains are intentionally not persisted, including raw payloads.
  // The client confirmed that hybrids are accepted and calculated by ICE displacement;
  // pure EV and hydrogen listings wait for a separate customs rule.
  const persistableItems = uniqueItems;
  const approvedItems = persistableItems.filter(
    (item) => item.screening.decision === "approved" && item.normalized,
  );
  const rejectedCount = uniqueItems.filter((item) => item.screening.decision === "rejected").length;
  const isolatedCount = uniqueItems.filter((item) => item.screening.decision === "isolated").length;

  let publishedCount = 0;
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
          details: { matchedTerms: item.screening.matchedTerms, evidence: item.screening.reasonEvidence,
            publicationGate: proofs.get(canonicalSourceId(item.bundle))?.proof ?? null, policy: CATALOG_POLICY },
          screened_at: new Date().toISOString(),
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
                preferential: true,
                profile,
                exchangeRates,
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
                krw_per_usd: profile.krwPerUsd,
                engine_cc: vehicle.engineCc,
                fuel_type: vehicle.fuelType,
                transmission: vehicle.transmission,
                drive_type: vehicle.driveType,
                body_type: vehicle.bodyType,
                exterior_color: vehicle.exteriorColor,
                location: vehicle.location,
                vin_masked: vehicle.vinMasked,
                status: "active",
                ...(publish ? { is_public: false, catalog_launch_id: String(runCursor.catalogLaunchId ?? process.env.CHESTNY_CATALOG_LAUNCH_ID ?? "") || null } : {}),
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
      const idBySource = new Map(
        storedVehicles.map((vehicle) => [vehicle.source_listing_id, vehicle.id]),
      );
      const identifierRows = approvedItems.flatMap((item) => {
        const vehicle = item.normalized!;
        const vehicleId = idBySource.get(vehicle.sourceListingId);
        if (!vehicleId) return [];
        return sourceIdentifiers(item.bundle).map((identifier) => ({
          source_identifier: identifier.value,
          vehicle_id: vehicleId,
          identifier_type: identifier.type,
          last_seen_at: item.bundle.fetchedAt,
        }));
      });
      // A source listing can expose the same canonical Encar identifier more
      // than once (for example, as both the advertised and canonical ID).
      // PostgreSQL cannot upsert the same conflict key twice in one statement.
      // Keep one row per identifier; the corresponding vehicle upsert above
      // already resolves the listing itself deterministically.
      const uniqueIdentifierRows = [
        ...new Map(identifierRows.map((row) => [row.source_identifier, row])).values(),
      ];
      if (uniqueIdentifierRows.length) {
        await checked(
          supabase
            .from("vehicle_source_identifiers")
            .upsert(uniqueIdentifierRows, { onConflict: "source_identifier" }),
        );
      }
      await checked(supabase.from("vehicle_images").delete().in("vehicle_id", vehicleIds));
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
      if (publish) {
        const reportRows = approvedItems.map(item => {
          const reports = item.enrichment?.rawReports ?? {};
          const diagnosisState = proofs.get(canonicalSourceId(item.bundle))?.proof.endpointStates.diagnosis;
          return { vehicle_id: idBySource.get(canonicalSourceId(item.bundle)), canonical_vehicle_id: canonicalSourceId(item.bundle),
            options: item.enrichment?.options ?? [], inspection_summary: inspectionSummary(reports.inspection, item.bundle, reports.diagnosis, diagnosisState === "ok"),
            accident_summary: accidentSummary(reports.insurance, reports.history), report_status: proofs.get(canonicalSourceId(item.bundle))?.reportStatus,
            fetched_at: item.bundle.fetchedAt };
        });
        await checked(supabase.from("vehicle_reports").upsert(reportRows, { onConflict: "vehicle_id" }));
        // Publish only after identifiers, images and reports were successfully stored.
        const publishedRows = await checked(supabase.from("vehicles").update({ is_public: true }).in("id", vehicleIds).not("price_usd", "is", null).select("id"));
        publishedCount = publishedRows?.length ?? 0;
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
    isolatedCount,
    errorCount: 0,
    published: publish,
    publishedCount,
  };
}
