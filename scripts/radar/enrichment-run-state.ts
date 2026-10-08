import type { SupabaseClient } from "@supabase/supabase-js";

// A terminal run is configuration that needs operator attention, not a
// transient error that a supervisor should retry every few seconds.
export const TERMINAL_RUN_EXIT_CODE = 78;

export function isTerminalRun(status: string) {
  return status === "completed" || status === "cancelled";
}

export function attemptedEnrichmentItems(counts: Record<string, number>) {
  return ["succeeded", "unavailable", "failed"].reduce((sum, status) => sum + (counts[status] ?? 0), 0);
}

export async function hasPendingEnrichment(db: SupabaseClient, runId: string) {
  const { data, error } = await db.from("chestny_enrichment_queue")
    .select("id")
    .eq("run_id", runId)
    .in("status", ["queued", "leased"])
    .limit(1);
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Missing enrichment queue response");
  return data.length > 0;
}
