export const MIN_WAVE_ITEMS = 50;
export const MAX_WAVE_ITEMS = 500;
export const WAVE_SIZE_STEP = 50;
export const STABLE_WAVES_TO_INCREASE = 3;

export type WaveCounts = {
  queued: number;
  leased: number;
  succeeded: number;
  unavailable: number;
  failed: number;
  cancelled: number;
};

export function processedQueueItems(counts: WaveCounts) {
  return counts.succeeded + counts.unavailable + counts.failed + counts.cancelled;
}

export function chooseNextWaveSize(input: {
  currentLimit: number;
  lastWaveLimit: number;
  previous: WaveCounts;
  current: WaveCounts;
  stableWaves: number;
}) {
  const attempted = Math.max(0, processedQueueItems(input.current) - processedQueueItems(input.previous));
  const failures = Math.max(0, input.current.failed - input.previous.failed);
  const waveWasFilled = attempted >= input.lastWaveLimit;
  const failureRate = attempted ? failures / attempted : 0;
  let nextLimit = Math.max(MIN_WAVE_ITEMS, Math.min(MAX_WAVE_ITEMS, input.currentLimit));
  let stableWaves = Math.max(0, input.stableWaves);

  if (!waveWasFilled || attempted === 0) return { attempted, failures, failureRate, nextLimit, stableWaves };

  if (failureRate >= 0.05 || failures >= 5) {
    nextLimit = Math.max(MIN_WAVE_ITEMS, nextLimit - WAVE_SIZE_STEP);
    stableWaves = 0;
  } else if (failureRate <= 0.02) {
    stableWaves += 1;
    if (stableWaves >= STABLE_WAVES_TO_INCREASE) {
      nextLimit = Math.min(MAX_WAVE_ITEMS, nextLimit + WAVE_SIZE_STEP);
      stableWaves = 0;
    }
  } else {
    stableWaves = 0;
  }

  return { attempted, failures, failureRate, nextLimit, stableWaves };
}
