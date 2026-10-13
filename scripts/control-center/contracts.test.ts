import assert from "node:assert/strict";
import { test } from "node:test";
import type { ControlModule, ControlTask, ControlTaskState, CoordinatorPlan, ModuleResult, Readiness } from "./contracts";
import { ModuleRegistry } from "./registry";
import { createControlModuleRegistry } from "./modules";
import { ControlTaskService } from "./task-service";
import { ControlTaskCoordinator } from "./coordinator";

const task: ControlTask = {
  id: "task-1", moduleId: "chestny-prigon.catalog", product: "chestny-prigon", source: "encar",
  goal: "Найти и обработать следующую волну", parameters: { maxItems: 50 }, state: "queued",
  progress: {}, result: null, externalRef: "run-1", createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z",
};

const result: ModuleResult = { state: "ready", summary: "Готово" };
const readiness: Readiness = { ready: true, summary: "Можно запускать", blockers: [], details: {} };

function operations(calls: string[]) {
  return {
    async checkReadiness() { calls.push("checkReadiness"); return readiness; },
    async run() { calls.push("run"); return result; },
    async pause() { calls.push("pause"); return result; },
    async resume() { calls.push("resume"); return result; },
    async stop() { calls.push("stop"); return result; },
    async getStatus() { calls.push("getStatus"); return result; },
    async planNext() { calls.push("planNext"); return { stage: "idle", action: null, summary: "Ожидание" } satisfies CoordinatorPlan; },
  };
}

test("Chestny Prigon is registered as a module with all standard lifecycle actions", async () => {
  const calls: string[] = [];
  const registry = createControlModuleRegistry(operations(calls));
  const module = registry.get("chestny-prigon.catalog");
  assert.equal(module.product, "chestny-prigon");
  assert.deepEqual(module.sources, ["encar"]);
  for (const action of ["checkReadiness", "run", "pause", "resume", "stop", "getStatus"] as const) {
    await registry.invoke(action, task);
  }
  assert.deepEqual(calls, ["checkReadiness", "run", "pause", "resume", "stop", "getStatus"]);
});

test("registry rejects duplicate modules and tasks sent to the wrong product/source", async () => {
  const calls: string[] = [];
  const registry = createControlModuleRegistry(operations(calls));
  const module = registry.get("chestny-prigon.catalog");
  assert.throws(() => registry.register(module), /already registered/);
  await assert.rejects(registry.invoke("run", { ...task, source: "other" }), /not supported/);
  await assert.rejects(registry.invoke("run", { ...task, product: "other" }), /does not match/);
  assert.equal(calls.length, 0);
});

test("a second product implements the same module contract without changing the registry", async () => {
  const calls: string[] = [];
  const base = operations(calls);
  const secondProduct: ControlModule = {
    id: "future-product.source-a", product: "future-product", sources: ["source-a"], ...base,
  };
  const registry = new ModuleRegistry();
  registry.register(secondProduct);
  assert.deepEqual(registry.list(), [{ id: secondProduct.id, product: secondProduct.product, sources: secondProduct.sources }]);
  await registry.invoke("getStatus", { ...task, id: "task-2", moduleId: secondProduct.id, product: secondProduct.product, source: "source-a" });
  assert.deepEqual(calls, ["getStatus"]);
});

test("task service persists readiness, lifecycle state, progress, and result", async () => {
  const calls: string[] = [];
  const registry = createControlModuleRegistry({
    ...operations(calls),
    async run() { calls.push("run"); return { state: "running", summary: "Поиск запущен", progress: { current: 2 }, result: { runId: "run-1" } }; },
  });
  let current = task;
  const store = {
    async get() { return current; },
    async listRunnable() { return [current]; },
    async findByExternalRef() { return null; },
    async update(_id: string, patch: { state?: ControlTaskState; progress?: Record<string, unknown>; result?: Record<string, unknown> | null }) {
      current = { ...current, ...patch };
      return current;
    },
  };
  const service = new ControlTaskService(store, registry);
  const ready = await service.invoke("checkReadiness", task.id);
  assert.equal(ready.task.state, "ready");
  const started = await service.invoke("run", task.id);
  assert.equal(started.task.state, "running");
  assert.deepEqual(started.task.progress, { current: 2 });
  assert.deepEqual(started.task.result, { runId: "run-1" });
  assert.deepEqual(calls, ["checkReadiness", "checkReadiness", "run"]);
});

test("task service refuses to run a module when readiness checks have blockers", async () => {
  const registry = createControlModuleRegistry({
    ...operations([]),
    async checkReadiness() { return { ready: false, summary: "Заблокировано", blockers: ["нет ключа"], details: {} }; },
  });
  const store = { async get() { return task; }, async listRunnable() { return [task]; }, async findByExternalRef() { return null; }, async update() { return task; } };
  const service = new ControlTaskService(store, registry);
  await assert.rejects(service.invoke("run", task.id), /нет ключа/);
});

test("coordinator persists stage and invokes the next module action after restoring a task", async () => {
  const calls: string[] = [];
  const registry = createControlModuleRegistry({
    ...operations(calls),
    async planNext() { return { stage: "enrichment", action: "run", summary: "Продолжить обогащение" }; },
    async run() { calls.push("run"); return { state: "running", summary: "Worker запущен", progress: { current: 4 } }; },
  });
  let current = task;
  const store = {
    async get() { return current; },
    async listRunnable() { return [current]; },
    async findByExternalRef() { return null; },
    async update(_id: string, patch: { state?: ControlTaskState; progress?: Record<string, unknown>; result?: Record<string, unknown> | null }) {
      current = { ...current, ...patch };
      return current;
    },
  };
  const service = new ControlTaskService(store, registry);
  const coordinator = new ControlTaskCoordinator(store, registry, service);
  const result = await coordinator.tick();
  assert.deepEqual(result, [{ taskId: task.id, stage: "enrichment", action: "run", summary: "Продолжить обогащение" }]);
  assert.equal(current.state, "running");
  assert.equal(current.progress.stage, "enrichment");
  assert.equal(current.progress.actionKey, `${task.id}:enrichment:0`);
  assert.deepEqual(calls, ["checkReadiness", "run"]);
});

test("coordinator persists planner failures as paused tasks with a recoverable error", async () => {
  const registry = createControlModuleRegistry({
    ...operations([]),
    async planNext() { throw new Error("Supabase temporarily unavailable"); },
  });
  let current: ControlTask = { ...task, state: "running" };
  const store = {
    async get() { return current; },
    async listRunnable() { return [current]; },
    async findByExternalRef() { return null; },
    async update(_id: string, patch: { state?: ControlTaskState; progress?: Record<string, unknown>; result?: Record<string, unknown> | null }) {
      current = { ...current, ...patch };
      return current;
    },
  };
  const coordinator = new ControlTaskCoordinator(store, registry, new ControlTaskService(store, registry));
  const outcome = await coordinator.tick();
  assert.equal(current.state, "paused");
  assert.equal(current.progress.stage, "coordinator_error");
  assert.deepEqual(current.result, { error: "Supabase temporarily unavailable", recovery: "coordinator_will_retry_after_owner_resume" });
  assert.equal(outcome[0]?.error, "Supabase temporarily unavailable");
});
