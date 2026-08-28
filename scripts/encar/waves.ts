/**
 * Safe, deterministic wave plan for the Encar catalogue intake.
 *
 * This module is intentionally side-effect free: it does not call Encar or
 * Supabase. A runner can consume the plan and execute one brand batch at a
 * time, recording the wave id and offset in import_runs.cursor.
 */

export type WaveGroup = "european" | "korean" | "other";

export type BrandWave = {
  id: string;
  group: WaveGroup;
  manufacturer: string;
  quota: number;
};

export const SAFE_BRAND_BATCH_SIZE = 500;
export const SAFE_DETAIL_DELAY_MS = 650;
export const SAFE_DETAIL_CONCURRENCY = 1;
export const SAFE_ENRICH_CONCURRENCY = 3;
export const MAX_ENRICH_CONCURRENCY = 4;

/**
 * Quotas are deliberately modest. They can be increased only after the
 * previous wave has been checked for errors, duplicates and publish rate.
 */
export const CATALOG_WAVES: readonly BrandWave[] = [
  { id: "eu-01-bmw", group: "european", manufacturer: "BMW", quota: 2_000 },
  { id: "eu-02-mercedes", group: "european", manufacturer: "Mercedes-Benz", quota: 2_000 },
  { id: "eu-03-audi", group: "european", manufacturer: "Audi", quota: 1_500 },
  { id: "eu-04-volkswagen", group: "european", manufacturer: "Volkswagen", quota: 1_500 },
  { id: "kr-01-hyundai", group: "korean", manufacturer: "Hyundai", quota: 3_000 },
  { id: "kr-02-kia", group: "korean", manufacturer: "Kia", quota: 3_000 },
  { id: "kr-03-genesis", group: "korean", manufacturer: "Genesis", quota: 1_500 },
  { id: "other-01", group: "other", manufacturer: "*", quota: 2_500 },
];

export function waveBatches(wave: BrandWave, batchSize = SAFE_BRAND_BATCH_SIZE) {
  if (!Number.isInteger(batchSize) || batchSize < 50 || batchSize > SAFE_BRAND_BATCH_SIZE) {
    throw new Error(`batchSize must be an integer from 50 to ${SAFE_BRAND_BATCH_SIZE}`);
  }
  const batches: Array<{ waveId: string; manufacturer: string; offset: number; limit: number }> = [];
  for (let offset = 0; offset < wave.quota; offset += batchSize) {
    batches.push({
      waveId: wave.id,
      manufacturer: wave.manufacturer,
      offset,
      limit: Math.min(batchSize, wave.quota - offset),
    });
  }
  return batches;
}

export function totalWaveQuota(group?: WaveGroup) {
  return CATALOG_WAVES
    .filter((wave) => !group || wave.group === group)
    .reduce((total, wave) => total + wave.quota, 0);
}
