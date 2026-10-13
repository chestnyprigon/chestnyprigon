import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { attemptedEnrichmentItems, hasPendingEnrichment, isTerminalRun } from "./enrichment-run-state";
import { appendOperationalFailure, FAILURE_WINDOW_MIN_ERRORS, FAILURE_WINDOW_SIZE, shouldPauseForOperationalFailures } from "./enrichment-failure-policy";

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

test("candidate limit counts completed queue outcomes across worker restarts", () => {
  assert.equal(attemptedEnrichmentItems({ queued: 31, leased: 1, succeeded: 15, unavailable: 2, failed: 1 }), 18);
  assert.equal(Math.max(0, 50 - attemptedEnrichmentItems({ succeeded: 49, failed: 1 })), 0);
});

test("isolated identity conflicts do not count toward the technical-failure stop threshold", () => {
  let samples: boolean[] = [];
  samples = appendOperationalFailure(samples, false);
  assert.equal(shouldPauseForOperationalFailures(samples), false);
});

test("technical failures stop a worker only after at least half of a ten-item window fail", () => {
  let samples: boolean[] = [];
  for (let i = 0; i < FAILURE_WINDOW_SIZE - 1; i += 1) {
    samples = appendOperationalFailure(samples, i < FAILURE_WINDOW_MIN_ERRORS - 1);
  }
  assert.equal(samples.length, FAILURE_WINDOW_SIZE - 1);
  assert.equal(shouldPauseForOperationalFailures(samples), false);
  samples = appendOperationalFailure(samples, true);
  assert.equal(samples.filter(Boolean).length, FAILURE_WINDOW_MIN_ERRORS);
  assert.equal(shouldPauseForOperationalFailures(samples), true);
  assert.equal(samples.length, FAILURE_WINDOW_SIZE);
});

test("old failures age out of the rolling stop window", () => {
  let samples: boolean[] = [true, true, true, true, true];
  for (let i = 0; i < FAILURE_WINDOW_SIZE; i += 1) samples = appendOperationalFailure(samples, false);
  assert.deepEqual(samples, Array(FAILURE_WINDOW_SIZE).fill(false));
  assert.equal(shouldPauseForOperationalFailures(samples), false);
});
