import type { ControlTask, ControlTaskState, ModuleAction, ModuleResult } from "./contracts";
import { ModuleRegistry } from "./registry";
import type { ControlTaskStore } from "./contracts";

const terminal = new Set<ControlTaskState>(["completed", "failed", "cancelled"]);

export class ControlTaskService {
  constructor(private readonly tasks: ControlTaskStore, private readonly modules: ModuleRegistry) {}

  async invoke(action: ModuleAction, taskId: string): Promise<{ task: ControlTask; result: ModuleResult }> {
    const task = await this.tasks.get(taskId);
    const module = this.modules.get(task.moduleId);
    if (action !== "getStatus" && terminal.has(task.state)) throw new Error(`Task ${taskId} is terminal (${task.state})`);

    if (action === "checkReadiness") {
      const readiness = await module.checkReadiness(task);
      const state = readiness.ready ? "ready" : task.state;
      const updated = await this.tasks.update(taskId, { state, result: { readiness } });
      return { task: updated, result: { state, summary: readiness.summary, result: { readiness } } };
    }

    if (action === "run" || action === "resume") {
      if (action === "resume" && task.state !== "paused") throw new Error(`Task ${taskId} can resume only from paused`);
      const readiness = await module.checkReadiness(task);
      if (!readiness.ready) throw new Error(`Module ${module.id} is not ready: ${readiness.blockers.join("; ") || readiness.summary}`);
    }
    if (action === "pause" && task.state !== "running") throw new Error(`Task ${taskId} can pause only from running`);
    if (action === "resume" && task.state !== "paused") throw new Error(`Task ${taskId} can resume only from paused`);
    if (action === "stop" && !["running", "paused", "queued", "ready", "preparing"].includes(task.state)) {
      throw new Error(`Task ${taskId} cannot stop from ${task.state}`);
    }

    const inFlightState: ControlTaskState = action === "run" || action === "resume" ? "running" : task.state;
    let currentTask = task;
    if (inFlightState !== task.state) {
      await this.tasks.update(taskId, { state: inFlightState });
      currentTask = await this.tasks.get(taskId);
    }
    try {
      const result = await module[action](currentTask);
      const updated = await this.tasks.update(taskId, {
        state: result.state,
        ...(result.externalRef !== undefined ? { externalRef: result.externalRef } : {}),
        ...(result.progress ? { progress: { ...currentTask.progress, ...result.progress } } : {}),
        result: result.result ?? { summary: result.summary },
      });
      return { task: updated, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.tasks.update(taskId, { state: "paused", result: { error: message, recovery: "owner_or_coordinator_retry" } });
      throw error;
    }
  }
}
