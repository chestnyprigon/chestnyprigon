import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ControlTask } from "./contracts";
import { ControlTaskCoordinator } from "./coordinator";
import { ModuleRegistry } from "./registry";
import { ControlTaskService } from "./task-service";
import { createChestnyPrigonRuntime } from "./modules/chestny-prigon-runtime";

test("coordinator starts a fresh pilot goal without an existing run and keeps publishing disabled", async () => {
  const launchId = "11111111-1111-4111-8111-111111111111";
  let current: ControlTask = {
    id: "task-pilot", moduleId: "chestny-prigon.catalog", product: "chestny-prigon", source: "encar",
    goal: "Пилот до 50 карточек", parameters: { launchId, pilotApproved: false, publishAuthorized: false },
    state: "queued", externalRef: null, progress: { intent: "initial_search", stage: "search_pending", waveNumber: 0 },
    result: null, createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z",
  };
  let searchCalls = 0;
  const db = {
    from(table: string) {
      assert.equal(table, "chestny_catalog_launches");
      const query = {
        select() { return query; },
        eq() { return query; },
        async maybeSingle() { return { data: { id: launchId, status: "prepared" }, error: null }; },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  const catalogModule = createChestnyPrigonRuntime({
    db, ownerId: "376069219", chatId: 376069219,
    async executeLegacyCommand() { throw new Error("No legacy run command should be used for the initial search"); },
    async startInitialWave(task) {
      searchCalls += 1;
      assert.equal(task.externalRef, null);
      return { runId: "22222222-2222-4222-8222-222222222222", queued: 50, summary: "Пилотный run создан" };
    },
  });
  const registry = new ModuleRegistry();
  registry.register(catalogModule);
  const store = {
    async get() { return current; },
    async listRunnable() { return [current]; },
    async findByExternalRef() { return null; },
    async update(_id: string, patch: Partial<ControlTask>) {
      current = { ...current, ...patch };
      return current;
    },
  };
  const coordinator = new ControlTaskCoordinator(store, registry, new ControlTaskService(store, registry));

  const outcomes = await coordinator.tick();

  assert.equal(searchCalls, 1);
  assert.equal(outcomes[0]?.stage, "search_candidates");
  assert.equal(current.externalRef, "22222222-2222-4222-8222-222222222222");
  assert.equal(current.state, "running");
  assert.equal(current.progress.stage, "enrichment_screening");
  assert.equal(current.progress.waveNumber, 1);
  assert.equal(current.parameters.publishAuthorized, false);
  assert.equal(current.parameters.pilotApproved, false);
});
