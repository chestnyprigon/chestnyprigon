import type { SupabaseClient } from "@supabase/supabase-js";
import type { ControlTask, ControlTaskState, JsonObject } from "./contracts";

type TaskRow = {
  id: string; module_id: string; product: string; source: string; goal: string;
  parameters: JsonObject; state: ControlTaskState; progress: JsonObject; result: JsonObject | null;
  created_at: string; updated_at: string; origin_update_id?: number | null; external_ref?: string | null;
};

function fromRow(row: TaskRow): ControlTask {
  return {
    id: row.id, moduleId: row.module_id, product: row.product, source: row.source, goal: row.goal,
    parameters: row.parameters ?? {}, state: row.state, progress: row.progress ?? {}, result: row.result,
    externalRef: row.external_ref ?? null, createdAt: row.created_at, updatedAt: row.updated_at,
    originUpdateId: row.origin_update_id ?? null,
  };
}

/** Supabase persistence for generic control tasks; no product-specific columns. */
export class ControlTaskRepository {
  constructor(private readonly db: SupabaseClient) {}

  async create(input: Pick<ControlTask, "moduleId" | "product" | "source" | "goal" | "parameters"> & { externalRef?: string | null; state?: ControlTaskState; progress?: JsonObject }): Promise<ControlTask> {
    const { data, error } = await this.db.from("control_center_tasks").insert({
      module_id: input.moduleId, product: input.product, source: input.source, goal: input.goal,
      parameters: input.parameters, external_ref: input.externalRef ?? null,
      state: input.state ?? "queued", progress: input.progress ?? {}, result: null,
    }).select("*").single();
    if (error) throw new Error(`Could not create control task: ${error.message}`);
    return fromRow(data as TaskRow);
  }

  async findByExternalRef(moduleId: string, externalRef: string): Promise<ControlTask | null> {
    const { data, error } = await this.db.from("control_center_tasks").select("*")
      .eq("module_id", moduleId).eq("external_ref", externalRef).maybeSingle();
    if (error) throw new Error(`Could not find control task: ${error.message}`);
    return data ? fromRow(data as TaskRow) : null;
  }

  async findActiveForLaunch(launchId: string): Promise<ControlTask | null> {
    const { data, error } = await this.db.from("control_center_tasks").select("*")
      .eq("module_id", "chestny-prigon.catalog").contains("parameters", { launchId })
      .in("state", ["queued", "preparing", "ready", "running", "paused"])
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(`Could not find active catalog goal: ${error.message}`);
    return data ? fromRow(data as TaskRow) : null;
  }

  async get(id: string): Promise<ControlTask> {
    const { data, error } = await this.db.from("control_center_tasks").select("*").eq("id", id).single();
    if (error) throw new Error(`Could not read control task ${id}: ${error.message}`);
    return fromRow(data as TaskRow);
  }

  async listRunnable(limit = 20): Promise<ControlTask[]> {
    const { data, error } = await this.db.from("control_center_tasks").select("*")
      .in("state", ["queued", "preparing", "ready", "running"])
      .order("updated_at", { ascending: true }).limit(Math.max(1, Math.min(limit, 100)));
    if (error) throw new Error(`Could not list runnable control tasks: ${error.message}`);
    return ((data ?? []) as TaskRow[]).map(fromRow);
  }

  async update(id: string, patch: { state?: ControlTaskState; externalRef?: string | null; progress?: JsonObject; result?: JsonObject | null }): Promise<ControlTask> {
    const values = {
      ...(patch.state ? { state: patch.state } : {}),
      ...(patch.externalRef !== undefined ? { external_ref: patch.externalRef } : {}),
      ...(patch.progress ? { progress: patch.progress } : {}),
      ...(patch.result !== undefined ? { result: patch.result } : {}),
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await this.db.from("control_center_tasks").update(values).eq("id", id).select("*").single();
    if (error) throw new Error(`Could not update control task ${id}: ${error.message}`);
    return fromRow(data as TaskRow);
  }
}
