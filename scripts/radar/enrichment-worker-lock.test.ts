import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withEnrichmentWorkerLock } from "./enrichment-worker-lock";

test("fails closed when another worker owns the global Supabase lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "encar-lock-test-"));
  const previous = process.env.ENCAR_COORDINATION_DIR;
  process.env.ENCAR_COORDINATION_DIR = directory;
  const calls: string[] = [];
  const db = { rpc: async (name: string) => {
    calls.push(name);
    return { data: name === "acquire_chestny_enrichment_worker_lock" ? false : null, error: null };
  } } as never;
  try {
    await assert.rejects(withEnrichmentWorkerLock({ db, runId: "run", task: async () => "must not run" }), /Another Encar enrichment worker/);
    assert.deepEqual(calls, ["acquire_chestny_enrichment_worker_lock"]);
  } finally {
    if (previous === undefined) delete process.env.ENCAR_COORDINATION_DIR;
    else process.env.ENCAR_COORDINATION_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a second local process cannot enter while the first process holds the lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "encar-lock-test-"));
  const previous = process.env.ENCAR_COORDINATION_DIR;
  process.env.ENCAR_COORDINATION_DIR = directory;
  const calls: string[] = [];
  const db = { rpc: async (name: string) => { calls.push(name); return { data: true, error: null }; } } as never;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const first = withEnrichmentWorkerLock({ db, runId: "run", task: async () => { entered(); await gate; } });
    await started;
    await assert.rejects(withEnrichmentWorkerLock({ db, runId: "other-run", task: async () => undefined }), /already holds the local lock/);
    release();
    await first;
    assert.deepEqual(calls, ["acquire_chestny_enrichment_worker_lock", "release_chestny_enrichment_worker_lock"]);
  } finally {
    release();
    if (previous === undefined) delete process.env.ENCAR_COORDINATION_DIR;
    else process.env.ENCAR_COORDINATION_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("reuses an inherited lock token for child worker batches without releasing the parent lock", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = { rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args }); return { data: true, error: null };
  } } as never;
  const result = await withEnrichmentWorkerLock({ db, runId: "run", inheritedToken: "parent-token", task: async () => 42 });
  assert.equal(result, 42);
  assert.deepEqual(calls.map((call) => call.name), ["acquire_chestny_enrichment_worker_lock"]);
  assert.equal(calls[0].args.p_token, "parent-token");
});
