export const CONTROL_TASK_STATES = [
  "queued", "preparing", "ready", "running", "paused", "completed", "failed", "cancelled",
] as const;

export type ControlTaskState = typeof CONTROL_TASK_STATES[number];
export type JsonObject = Record<string, unknown>;

/** Persisted, product-neutral description of one user goal. */
export type ControlTask = {
  id: string;
  moduleId: string;
  product: string;
  source: string;
  goal: string;
  parameters: JsonObject;
  state: ControlTaskState;
  externalRef: string | null;
  originUpdateId?: number | null;
  progress: JsonObject;
  result: JsonObject | null;
  createdAt: string;
  updatedAt: string;
};

export type Readiness = {
  ready: boolean;
  summary: string;
  blockers: string[];
  details: JsonObject;
};

export type ModuleResult = {
  state: ControlTaskState;
  summary: string;
  externalRef?: string | null;
  progress?: JsonObject;
  result?: JsonObject;
};

export type CoordinatorPlan = {
  stage: string;
  action: ModuleAction | null;
  summary: string;
  state?: ControlTaskState;
  progress?: JsonObject;
  result?: JsonObject;
};

/** Every product adapter exposes the same lifecycle operations. */
export interface ControlModule {
  readonly id: string;
  readonly product: string;
  readonly sources: readonly string[];
  checkReadiness(task: ControlTask): Promise<Readiness>;
  run(task: ControlTask): Promise<ModuleResult>;
  pause(task: ControlTask): Promise<ModuleResult>;
  resume(task: ControlTask): Promise<ModuleResult>;
  stop(task: ControlTask): Promise<ModuleResult>;
  getStatus(task: ControlTask): Promise<ModuleResult>;
  planNext(task: ControlTask): Promise<CoordinatorPlan>;
}

export type ModuleAction = "checkReadiness" | "run" | "pause" | "resume" | "stop" | "getStatus";

export type ControlTaskStore = {
  get(id: string): Promise<ControlTask>;
  listRunnable(limit: number): Promise<ControlTask[]>;
  findByExternalRef(moduleId: string, externalRef: string): Promise<ControlTask | null>;
  update(id: string, patch: { state?: ControlTaskState; externalRef?: string | null; progress?: JsonObject; result?: JsonObject | null }): Promise<ControlTask>;
};

export function assertTaskMatchesModule(task: ControlTask, module: Pick<ControlModule, "id" | "product" | "sources">): void {
  if (task.moduleId !== module.id) throw new Error(`Task module ${task.moduleId} does not match ${module.id}`);
  if (task.product !== module.product) throw new Error(`Task product ${task.product} does not match ${module.product}`);
  if (!module.sources.includes(task.source)) throw new Error(`Source ${task.source} is not supported by ${module.id}`);
  if (!task.goal.trim()) throw new Error("Task goal must not be empty");
}
