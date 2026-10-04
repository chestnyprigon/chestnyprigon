import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { hasPendingEnrichment, isTerminalRun } from "./enrichment-run-state";

test("pending check filters before limiting, so terminal rows cannot hide pending work", async () => {
  for (const status of ["queued", "leased", "succeeded"]) {
    const db = createClient("https://example.supabase.co", "test-key", {
      global: { fetch: async (input) => {
        const url = new URL(String(input));
        assert.equal(url.pathname, "/rest/v1/chestny_enrichment_queue");
        assert.equal(url.searchParams.get("run_id"), "eq.test-run");
        assert.equal(url.searchParams.get("status"), "in.(queued,leased)");
        assert.equal(url.searchParams.get("select"), "id");
        assert.equal(url.searchParams.get("limit"), "1");
        return new Response(JSON.stringify(status === "succeeded" ? [] : [{ id: "pending-id" }]), {
          headers: { "Content-Type": "application/json" },
        });
      } },
    });
    assert.equal(await hasPendingEnrichment(db, "test-run"), status !== "succeeded");
  }
});

test("database errors never look like an empty queue", async () => {
  const db = createClient("https://example.supabase.co", "test-key", {
    global: { fetch: async () => new Response(JSON.stringify({ message: "permission denied" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    }) },
  });
  await assert.rejects(hasPendingEnrichment(db, "test-run"), /permission denied/);
});

test("only completed and cancelled runs are terminal", () => {
  for (const status of ["approved", "running", "awaiting_approval"]) assert.equal(isTerminalRun(status), false);
  for (const status of ["completed", "cancelled"]) assert.equal(isTerminalRun(status), true);
});
