import type { ControlTask, CoordinatorPlan, JsonObject, ModuleAction } from "./contracts";
import { ModuleRegistry } from "./registry";
import { ControlTaskService } from "./task-service";
import type { ControlTaskStore } from "./contracts";

export type CoordinatorTick = { taskId: string; stage: string; action: ModuleAction | null; summary: string; error?: string };

/** Re-evaluates persisted tasks on each tick so a process restart can resume safely. */
export class ControlTaskCoordinator {
  constructor(private readonly tasks: ControlTaskStore, private readonly modules: ModuleRegistry, private readonly service: ControlTaskService) {}

  async tick(limit = 5): Promise<CoordinatorTick[]> {
    const tasks = await this.tasks.listRunnable(limit);
    const outcomes: CoordinatorTick[] = [];
    for (const task of tasks) {
      const module = this.modules.get(task.moduleId);
      let plan: CoordinatorPlan;
      try {
        plan = await module.planNext(task);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const progress: JsonObject = {
          ...task.progress,
          stage: "coordinator_error",
          lastErrorAt: new Date().toISOString(),
        };
        await this.tasks.update(task.id, {
          state: "paused",
          progress,
          result: { error: message, recovery: "coordinator_will_retry_after_owner_resume" },
        });
        outcomes.push({ taskId: task.id, stage: "coordinator_error", action: null, summary: "Координатор приостановил задачу после ошибки планирования", error: message });
        continue;
      }
      const progress: JsonObject = { ...task.progress, ...(plan.progress ?? {}), stage: plan.stage,
        coordinatorSummary: plan.summary };
      if (!plan.action) {
        const changed = (plan.state && plan.state !== task.state)
          || task.progress.stage !== plan.stage || task.progress.coordinatorSummary !== plan.summary
          || (plan.result && JSON.stringify(task.result) !== JSON.stringify(plan.result));
        if (changed) await this.tasks.update(task.id, {
          ...(plan.state ? { state: plan.state } : {}), progress,
          ...(plan.result ? { result: plan.result } : {}),
        });
        outcomes.push({ taskId: task.id, stage: plan.stage, action: null, summary: plan.summary });
        continue;
      }

      const actionKey = `${task.id}:${plan.stage}:${String(task.progress.actionAttempt ?? 0)}`;
      await this.tasks.update(task.id, {
        ...(plan.state ? { state: plan.state } : {}),
        progress: { ...progress, action: plan.action, actionKey },
      });
      const refreshed = await this.tasks.get(task.id);
      try {
        await this.service.invoke(plan.action, refreshed.id);
        outcomes.push({ taskId: task.id, stage: plan.stage, action: plan.action, summary: plan.summary });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempts = Number(refreshed.progress.actionAttempt ?? 0) + 1;
        await this.tasks.update(task.id, {
          state: "paused",
          progress: { ...refreshed.progress, actionAttempt: attempts, lastErrorAt: new Date().toISOString() },
          result: { error: message },
        });
        outcomes.push({ taskId: task.id, stage: plan.stage, action: plan.action, summary: "Этап приостановлен после ошибки", error: message });
      }
    }
    return outcomes;
  }
}
