import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseNextWaveSize, type WaveCounts } from "./adaptive-wave-size";

const before: WaveCounts = { queued: 500, leased: 0, succeeded: 0, unavailable: 0, excluded: 0, failed: 0, cancelled: 0 };

function after(attempted: number, failed = 0): WaveCounts {
  return { queued: before.queued - attempted, leased: 0, succeeded: attempted - failed, unavailable: 0, excluded: 0, failed, cancelled: 0 };
}

test("keeps the current wave limit until three stable full waves finish", () => {
  const one = chooseNextWaveSize({ currentLimit: 100, lastWaveLimit: 100, previous: before, current: after(100, 2), stableWaves: 0 });
  assert.equal(one.nextLimit, 100);
  assert.equal(one.stableWaves, 1);
  const two = chooseNextWaveSize({ currentLimit: 100, lastWaveLimit: 100, previous: before, current: after(100, 1), stableWaves: one.stableWaves });
  assert.equal(two.nextLimit, 100);
  assert.equal(two.stableWaves, 2);
  const three = chooseNextWaveSize({ currentLimit: 100, lastWaveLimit: 100, previous: before, current: after(100, 0), stableWaves: two.stableWaves });
  assert.equal(three.nextLimit, 150);
  assert.equal(three.stableWaves, 0);
});

test("shrinks by one step after an elevated failure rate", () => {
  const result = chooseNextWaveSize({ currentLimit: 200, lastWaveLimit: 200, previous: before, current: after(200, 10), stableWaves: 2 });
  assert.equal(result.nextLimit, 150);
  assert.equal(result.stableWaves, 0);
});

test("does not change size for a partial final wave", () => {
  const result = chooseNextWaveSize({ currentLimit: 100, lastWaveLimit: 100, previous: before, current: after(27, 0), stableWaves: 2 });
  assert.equal(result.nextLimit, 100);
  assert.equal(result.stableWaves, 2);
});
