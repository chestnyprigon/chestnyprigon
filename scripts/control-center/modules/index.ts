import { ModuleRegistry } from "../registry";
import { createChestnyPrigonCatalogModule, type ChestnyPrigonOperations } from "./chestny-prigon";

/** Build a registry per process and inject that product's runtime ports. */
export function createControlModuleRegistry(chestnyPrigon: ChestnyPrigonOperations): ModuleRegistry {
  const registry = new ModuleRegistry();
  registry.register(createChestnyPrigonCatalogModule(chestnyPrigon));
  return registry;
}
