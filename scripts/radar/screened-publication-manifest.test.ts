import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPublicationManifest, publicationManifestFromScreening, savePublicationManifest, validatePublicationManifest } from "./screened-publication-manifest";

const runId = "11111111-1111-4111-8111-111111111111";
function report(ids: string[]) {
  return { status: "completed", runId, readyForPublication: ids.length, ready: ids.map(sourceListingId => ({ sourceListingId })) };
}

test("publication uses the full report and rejects truncated, duplicate, or foreign rosters", () => {
  const full = report(Array.from({ length: 500 }, (_, index) => String(10000 + index)));
  assert.equal(publicationManifestFromScreening(full, runId)?.selectedCount, 500);
  assert.throws(() => publicationManifestFromScreening({ ...full, ready: full.ready.slice(0, 20) }, runId));
  assert.throws(() => publicationManifestFromScreening(report(["1", "1"]), runId));
  assert.throws(() => publicationManifestFromScreening({ ...full, runId: "another-run" }, runId));
  const manifest = publicationManifestFromScreening(report(["1", "2"]), runId)!;
  assert.throws(() => validatePublicationManifest({ ...manifest, sourceListingIds: ["1", "3"] }, runId));
  assert.equal(publicationManifestFromScreening(report([]), runId), null);
});

test("resume preserves the exact original roster even when a repeated screening excludes published IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "catalog-manifest-"));
  try {
    const file = join(directory, "manifest.json");
    assert.equal(await loadPublicationManifest(file, runId), null);
    const first = publicationManifestFromScreening(report(["1", "2", "3"]), runId)!;
    await savePublicationManifest(file, first);
    const remaining = publicationManifestFromScreening(report(["3"]), runId)!;
    assert.deepEqual(await savePublicationManifest(file, remaining), first);
    assert.deepEqual(await loadPublicationManifest(file, runId), first);
    await writeFile(file, "{broken");
    await assert.rejects(() => loadPublicationManifest(file, runId));
    await assert.rejects(() => savePublicationManifest(file, first));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
