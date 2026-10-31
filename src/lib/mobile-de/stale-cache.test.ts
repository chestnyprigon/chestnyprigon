import assert from "node:assert/strict";
import test from "node:test";
import { createStaleCache } from "./stale-cache";

test("serves a fresh catalogue response without another upstream read", async () => {
  let now = 0;
  let calls = 0;
  const cache = createStaleCache<number>(60, 300, 4, () => now);
  const load = async () => ++calls;

  assert.equal(await cache("default", load), 1);
  now = 59;
  assert.equal(await cache("default", load), 1);
  assert.equal(calls, 1);
});

test("returns last known-good data while refreshing and after an upstream error", async () => {
  let now = 0;
  const cache = createStaleCache<string>(60, 300, 4, () => now);
  assert.equal(await cache("default", async () => "known-good"), "known-good");

  now = 61;
  assert.equal(await cache("default", async () => { throw new Error("DB timeout"); }), "known-good");
  await new Promise((resolve) => setImmediate(resolve));

  now = 361;
  await assert.rejects(cache("default", async () => { throw new Error("DB timeout"); }), /DB timeout/);
});

test("coalesces parallel cold requests", async () => {
  const cache = createStaleCache<number>(60, 300);
  let calls = 0;
  const load = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return 42;
  };

  assert.deepEqual(await Promise.all([cache("default", load), cache("default", load)]), [42, 42]);
  assert.equal(calls, 1);
});
