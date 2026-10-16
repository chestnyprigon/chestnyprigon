import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("macOS launcher never picks a route or starts work without an explicit transport", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "catalog-launcher-"));
  const launch = () => spawnSync("/bin/zsh", ["deploy/macos/run-catalog-worker.zsh"], {
    env: { ...process.env, CHESTNY_WORKER_STATE_DIR: directory, CHESTNY_WORKER_LOG_DIR: directory }, encoding: "utf8",
  });
  try {
    assert.equal(launch().status, 0); // No active-run means no work.
    await writeFile(join(directory, "active-run"), "11111111-1111-4111-8111-111111111111");
    assert.equal(launch().status, 64);
    assert.match(await readFile(join(directory, "worker.log"), "utf8"), /missing active transport/);
    await writeFile(join(directory, "active-transport"), "invalid");
    assert.equal(launch().status, 64);
    assert.match(await readFile(join(directory, "worker.log"), "utf8"), /invalid active transport/);
    assert.doesNotMatch(await readFile(join(directory, "worker.log"), "utf8"), /starting run/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
