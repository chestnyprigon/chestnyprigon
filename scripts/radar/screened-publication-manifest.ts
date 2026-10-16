import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ScreenedPublicationManifest = {
  status: "prepared";
  runId: string;
  selectedCount: number;
  selectedSourceIdsSha256: string;
  sourceListingIds: string[];
};

function checksum(ids: string[]) {
  return createHash("sha256").update(ids.join("\n")).digest("hex");
}

export function validatePublicationManifest(value: unknown, runId: string): ScreenedPublicationManifest {
  const manifest = value as Partial<ScreenedPublicationManifest> | null;
  const ids = manifest?.sourceListingIds;
  if (!manifest || manifest.status !== "prepared" || manifest.runId !== runId
    || !Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== "string" || !/^\d+$/.test(id))
    || new Set(ids).size !== ids.length || manifest.selectedCount !== ids.length
    || manifest.selectedSourceIdsSha256 !== checksum(ids)) {
    throw new Error("Saved publication manifest has invalid IDs, checksum, count, or run reference");
  }
  return manifest as ScreenedPublicationManifest;
}

export function publicationManifestFromScreening(value: unknown, runId: string): ScreenedPublicationManifest | null {
  const report = value as { status?: string; runId?: string; readyForPublication?: number; ready?: Array<{ sourceListingId?: unknown }> } | null;
  if (!report || report.status !== "completed" || report.runId !== runId || !Array.isArray(report.ready)
    || report.readyForPublication !== report.ready.length) throw new Error("Screening report does not match the publication run or full ready roster");
  if (report.ready.length === 0) return null;
  const ids = report.ready.map(row => row.sourceListingId) as string[];
  return validatePublicationManifest({ status: "prepared", runId, selectedCount: ids.length,
    selectedSourceIdsSha256: checksum(ids), sourceListingIds: ids }, runId);
}

export async function loadPublicationManifest(file: string, runId: string) {
  try { return validatePublicationManifest(JSON.parse(await readFile(file, "utf8")), runId); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function savePublicationManifest(file: string, manifest: ScreenedPublicationManifest) {
  validatePublicationManifest(manifest, manifest.runId);
  await mkdir(dirname(file), { recursive: true });
  try { await writeFile(file, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // The original roster always wins, including after a partial publication.
  const saved = await loadPublicationManifest(file, manifest.runId);
  if (!saved) throw new Error("Publication manifest disappeared before it could be read");
  return saved;
}
