import type { ControlModule, ControlTask, CoordinatorPlan, ModuleResult, Readiness } from "../contracts";

/** Bridge to the current Chestny Prigon run/queue implementation. */
export type ChestnyPrigonOperations = {
  checkReadiness(task: ControlTask): Promise<Readiness>;
  run(task: ControlTask): Promise<ModuleResult>;
  pause(task: ControlTask): Promise<ModuleResult>;
  resume(task: ControlTask): Promise<ModuleResult>;
  stop(task: ControlTask): Promise<ModuleResult>;
  getStatus(task: ControlTask): Promise<ModuleResult>;
  planNext(task: ControlTask): Promise<CoordinatorPlan>;
};

export function createChestnyPrigonCatalogModule(operations: ChestnyPrigonOperations): ControlModule {
  return {
    id: "chestny-prigon.catalog",
    product: "chestny-prigon",
    sources: ["encar"],
    ...operations,
  };
}
