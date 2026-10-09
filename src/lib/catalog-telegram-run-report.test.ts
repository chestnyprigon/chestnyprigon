import assert from "node:assert/strict";
import test from "node:test";
import { renderRunBrandProgress, summarizeRunBrandProgress } from "./catalog-telegram-run-report";

test("summarizes current run queue by source manufacturer and queue status", () => {
  const summary = summarizeRunBrandProgress([
    { manufacturer: "Hyundai", candidates: 580 },
    { manufacturer: "BMW", candidates: 480 },
  ], [
    { manufacturer: "현대", status: "succeeded" },
    { manufacturer: "현대", status: "queued" },
    { manufacturer: "BMW", status: "failed" },
    { manufacturer: "unknown", status: "queued" },
  ]);

  assert.deepEqual(summary.brands.map(({ manufacturer, found, queued, succeeded, failed }) => ({ manufacturer, found, queued, succeeded, failed })), [
    { manufacturer: "Hyundai", found: 2, queued: 1, succeeded: 1, failed: 0 },
    { manufacturer: "BMW", found: 1, queued: 0, succeeded: 0, failed: 1 },
  ]);
  assert.equal(summary.unmatched, 1);
});

test("formats candidate quotas separately from publication totals", () => {
  const progress = summarizeRunBrandProgress([{ manufacturer: "Hyundai", candidates: 10 }], [
    { manufacturer: "현대", status: "succeeded" },
    { manufacturer: "현대", status: "queued" },
  ]);
  const report = renderRunBrandProgress({ runId: "run-1", plannedCandidates: 10, candidateCount: 2, progress });

  assert.match(report, /Квоты текущего прогона/);
  assert.match(report, /найдено 2\/10/);
  assert.match(report, /Это план кандидатов, а не число публикаций/);
  assert.doesNotMatch(report, /опубликовано/);
});

test("escapes brand labels in Telegram HTML", () => {
  const progress = summarizeRunBrandProgress([{ manufacturer: "<Brand>", candidates: 1 }], [
    { manufacturer: "<Brand>", status: "queued" },
  ]);
  const report = renderRunBrandProgress({ runId: "run-1", plannedCandidates: 1, candidateCount: 1, progress });
  assert.match(report, /&lt;Brand&gt;/);
});
