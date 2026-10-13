import { assertTaskMatchesModule, type ControlModule, type ControlTask, type ModuleAction } from "./contracts";

export class ModuleRegistry {
  private readonly modules = new Map<string, ControlModule>();

  register(module: ControlModule): void {
    if (this.modules.has(module.id)) throw new Error(`Control module already registered: ${module.id}`);
    if (!module.id.trim() || !module.product.trim() || module.sources.length === 0) {
      throw new Error("A module must declare an id, product, and at least one source");
    }
    this.modules.set(module.id, module);
  }

  get(moduleId: string): ControlModule {
    const module = this.modules.get(moduleId);
    if (!module) throw new Error(`Unknown control module: ${moduleId}`);
    return module;
  }

  list(): Array<Pick<ControlModule, "id" | "product" | "sources">> {
    return [...this.modules.values()].map(({ id, product, sources }) => ({ id, product, sources }));
  }

  async invoke(action: ModuleAction, task: ControlTask) {
    const module = this.get(task.moduleId);
    assertTaskMatchesModule(task, module);
    return module[action](task);
  }
}
