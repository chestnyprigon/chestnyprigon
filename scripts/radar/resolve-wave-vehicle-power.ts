import { createHash } from "node:crypto";
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { screenStaging } from "../encar/staging-gate";
import { vehiclePowerRecordIssue } from "../encar/vehicle-power-gate";

config({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const RUN_ID = process.argv.find((arg) => arg.startsWith("--run-id="))?.slice(9)?.trim();
const WAVE_NUMBER = Number(process.argv.find((arg) => arg.startsWith("--wave-number="))?.slice(14));
const CONCURRENCY = Number(process.argv.find((arg) => arg.startsWith("--concurrency="))?.slice(14) ?? 2);
const BASE = process.env.VEHICLE_POWER_API_BASE_URL?.trim().replace(/\/+$/, "");
const TOKEN = process.env.VEHICLE_POWER_RESOLVE_TOKEN?.trim();
function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function powertrainFor(fuel: string, hybrid: boolean) {
  const value = fuel.toLowerCase();
  if (hybrid || /hybrid|hev|phev|하이브리드|가솔린\s*\+\s*전기|디젤\s*\+\s*전기/u.test(value)) {
    if (/phev|plug[ -]?in|플러그인/u.test(value)) return "hybrid_phev";
    if (/series|sequential|range[ -]?extender|직렬/u.test(value)) return "hybrid_sequential";
    return "hybrid_parallel";
  }
  if (/electric|전기|\bev\b/u.test(value)) return "electric";
  return "ice";
}
function tksUsable(power: Record<string, unknown>) {
  const propulsion = String(power.propulsion ?? "");
  const measurements = Array.isArray(power.measurements) ? power.measurements as Array<Record<string, unknown>> : [];
  const has = (basis: string) => measurements.some((item) => item.basis === basis
    && typeof item.kw === "number" && Number.isFinite(item.kw) && Number(item.kw) > 0);
  if (propulsion === "ice") return has("combustion_rated");
  if (propulsion === "electric" || propulsion === "hybrid_sequential") return has("electric_30min");
  if (propulsion === "hybrid_parallel" || propulsion === "hybrid_phev") return has("combustion_rated") && has("electric_30min");
  return false;
}

async function main() {
  const runId = required(RUN_ID, "--run-id");
  if (!Number.isInteger(WAVE_NUMBER) || WAVE_NUMBER < 1) throw new Error("Pass a positive --wave-number");
  if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1 || CONCURRENCY > 3) throw new Error("--concurrency must be 1..3");
  required(BASE, "VEHICLE_POWER_API_BASE_URL");
  required(TOKEN, "VEHICLE_POWER_RESOLVE_TOKEN");
  const db = createClient(required(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    required(process.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  const [runResult, waveResult] = await Promise.all([
    db.from("chestny_enrichment_runs").select("id,status,rules").eq("id", runId).single(),
    db.from("chestny_enrichment_waves").select("id,wave_number,status").eq("run_id", runId).eq("wave_number", WAVE_NUMBER).single(),
  ]);
  if (runResult.error) throw new Error(`Could not read run: ${runResult.error.message}`);
  if (waveResult.error) throw new Error(`Could not read wave: ${waveResult.error.message}`);
  const runData = runResult.data;
  const waveData = waveResult.data;
  if (!runData || !waveData) throw new Error("Run or wave was not found");
  if (record(runData.rules).powerGate !== "vehicle_power_required") throw new Error("Run is not configured with the Vehicle Power publication gate");
  if (!["screening", "ready", "completed"].includes(waveData.status)) throw new Error(`Wave ${WAVE_NUMBER} has not completed screening`);

  const queue = await db.from("chestny_enrichment_queue").select("source_listing_id,status")
    .eq("run_id", runId).eq("wave_id", waveData.id).eq("status", "succeeded");
  if (queue.error) throw new Error(`Could not read screened wave candidates: ${queue.error.message}`);
  const ids = (queue.data ?? []).map((item) => String(item.source_listing_id));
  const stageRows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ids.length; i += 25) {
    const stage = await db.from("chestny_catalog_staging")
      .select("source_listing_id,source_url,candidate_snapshot,encar_payload,image_urls,report_status,enrichment_status,updated_at")
      .in("source_listing_id", ids.slice(i, i + 25));
    if (stage.error) throw new Error(`Could not read staged vehicles: ${stage.error.message}`);
    stageRows.push(...(stage.data ?? []));
  }
  const eligible = stageRows.map((row) => ({ row, screened: screenStaging(row) }))
    .filter(({ screened }) => screened.screening.decision === "approved");
  const existing = new Map<string, { status: string; attempt_count: number; configuration_fingerprint: string | null; first_attempt_at: string }>();
  for (let i = 0; i < ids.length; i += 100) {
    const saved = await db.from("chestny_catalog_power_resolutions")
      .select("source_listing_id,status,attempt_count,configuration_fingerprint,first_attempt_at")
      .eq("run_id", runId).in("source_listing_id", ids.slice(i, i + 100));
    if (saved.error) throw new Error(`Could not read saved power resolutions (apply migration 20261113120000_catalog_vehicle_power_gate.sql): ${saved.error.message}`);
    for (const item of saved.data ?? []) existing.set(item.source_listing_id, item);
  }

  const outcomes: Array<{ id: string; status: string; reason: string }> = [];
  let cursor = 0;
  async function resolveNext() {
    while (cursor < eligible.length) {
      const item = eligible[cursor++];
      const id = String(item.row.source_listing_id);
      const prior = existing.get(id);
      if (prior?.status === "resolved") {
        outcomes.push({ id, status: "resolved", reason: "already_resolved" });
        continue;
      }
      const normalized = item.screened.normalized;
      if (!normalized) continue;
      const input = {
        brand: normalized.manufacturer, model: normalized.model,
        ...(normalized.generation ? { generation: normalized.generation } : {}),
        ...(normalized.trim ? { trim: normalized.trim } : {}),
        fuelType: normalized.fuelType,
        ...(normalized.driveType ? { driveType: normalized.driveType } : {}),
        market: "South Korea", year: normalized.modelYear,
        ...(normalized.firstRegistrationDate ? { firstRegistrationYear: Number(normalized.firstRegistrationDate.slice(0, 4)) } : {}),
        ...(normalized.engineCc ? { engineCc: normalized.engineCc } : {}),
        powertrain: powertrainFor(normalized.fuelType, item.screened.screening.isHybrid),
        correlation: { source: "encar", sourceListingId: id },
      };
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const timestamp = new Date().toISOString();
      let status = "retryable_error";
      let reasonCode = "vehicle_power_request_failed";
      let reasonDetail: string | null = null;
      let powerRecord: Record<string, unknown> | null = null;
      let responseBody: Record<string, unknown> | null = null;
      let referenceVersion: string | null = null;
      try {
        const response = await fetch(`${BASE}/v1/power/resolve`, {
          method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(input), cache: "no-store", signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`Vehicle Power returned HTTP ${response.status}`);
        responseBody = record(await response.json());
        referenceVersion = typeof responseBody.referenceVersion === "string" ? responseBody.referenceVersion : null;
        const returned = record(responseBody.record);
        const selections = Array.isArray(responseBody.selectionCandidates) ? responseBody.selectionCandidates : [];
        if (responseBody.status === "REVIEW_REQUIRED" || selections.length > 1) {
          status = "ambiguous"; reasonCode = "multiple_or_review_required_matches";
        } else if (responseBody.status === "NOT_FOUND" || !Object.keys(returned).length) {
          status = "not_found"; reasonCode = "vehicle_power_record_not_found";
        } else {
          const issue = vehiclePowerRecordIssue(returned);
          if (issue) {
            status = "incompatible_power"; reasonCode = issue;
          } else if (!tksUsable(returned)) {
            status = "incompatible_power"; reasonCode = "missing_tks_compatible_measurement";
          } else if (returned.propulsion !== input.powertrain) {
            status = "ambiguous"; reasonCode = "resolved_powertrain_does_not_match_vehicle";
          } else {
            status = "resolved"; reasonCode = "source_backed_tks_compatible_power_found"; powerRecord = returned;
          }
        }
      } catch (error) {
        reasonDetail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      }
      const saved = await db.from("chestny_catalog_power_resolutions").upsert({
        run_id: runId, wave_id: waveData.id, source_listing_id: id, status, reason_code: reasonCode,
        reason_detail: reasonDetail, configuration_fingerprint: fingerprint, reference_version: referenceVersion,
        power_record: powerRecord, response: responseBody,
        attempt_count: (prior?.attempt_count ?? 0) + 1, first_attempt_at: prior?.first_attempt_at ?? timestamp, last_attempt_at: timestamp,
        resolved_at: status === "resolved" ? timestamp : null,
      }, { onConflict: "run_id,source_listing_id" });
      if (saved.error) throw new Error(`Could not persist power resolution for ${id}: ${saved.error.message}`);
      outcomes.push({ id, status, reason: reasonCode });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => resolveNext()));
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  console.log(JSON.stringify({ runId, waveNumber: WAVE_NUMBER, screenedApproved: eligible.length,
    alreadyResolved: outcomes.filter((item) => item.reason === "already_resolved").length,
    attempted: outcomes.length, counts, reasonCounts: outcomes.reduce<Record<string, number>>((acc, item) => {
      if (item.reason !== "already_resolved") acc[item.reason] = (acc[item.reason] ?? 0) + 1;
      return acc;
    }, {}), publicationExecuted: false }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
