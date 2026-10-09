import { manufacturerAliases } from "../../scripts/encar/manufacturer-aliases";

export type RunQuota = { manufacturer: string; candidates: number };
export type RunQueueRow = { status: string; manufacturer: string | null };
export type RunBrandProgress = RunQuota & {
  found: number;
  queued: number;
  leased: number;
  succeeded: number;
  unavailable: number;
  failed: number;
  cancelled: number;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character] ?? character);
}

export function summarizeRunBrandProgress(quotas: RunQuota[], rows: RunQueueRow[]) {
  const progress = new Map<string, RunBrandProgress>(quotas.map((quota) => [quota.manufacturer, {
    ...quota, found: 0, queued: 0, leased: 0, succeeded: 0, unavailable: 0, failed: 0, cancelled: 0,
  }]));
  let unmatched = 0;

  for (const row of rows) {
    const sourceName = row.manufacturer?.trim().toLocaleLowerCase();
    const brand = quotas.find((quota) => {
      if (!sourceName) return false;
      return [quota.manufacturer, ...manufacturerAliases(quota.manufacturer)]
        .some((alias) => sourceName === alias.toLocaleLowerCase());
    });
    const counts = brand ? progress.get(brand.manufacturer) : undefined;
    if (!counts) {
      unmatched += 1;
      continue;
    }
    counts.found += 1;
    if (["queued", "leased", "succeeded", "unavailable", "failed", "cancelled"].includes(row.status)) {
      (counts as unknown as Record<string, number>)[row.status] += 1;
    }
  }

  return { brands: [...progress.values()], unmatched };
}

export function renderRunBrandProgress(input: {
  runId: string;
  plannedCandidates: number;
  candidateCount: number;
  progress: ReturnType<typeof summarizeRunBrandProgress>;
}) {
  const { runId, plannedCandidates, candidateCount, progress } = input;
  const processed = progress.brands.reduce((sum, brand) => sum + brand.succeeded + brand.unavailable + brand.failed + brand.cancelled, 0);
  const queued = progress.brands.reduce((sum, brand) => sum + brand.queued, 0);
  const leased = progress.brands.reduce((sum, brand) => sum + brand.leased, 0);
  const lines = progress.brands.map((brand) => {
    const done = brand.succeeded + brand.unavailable + brand.failed + brand.cancelled;
    return `• <b>${escapeHtml(brand.manufacturer)}</b> — найдено ${brand.found}/${brand.candidates}; обработано ${done} (успешно ${brand.succeeded}, недоступно ${brand.unavailable}, ошибок ${brand.failed}, отменено ${brand.cancelled}); ждут ${brand.queued}; в работе ${brand.leased}`;
  });
  if (progress.unmatched) lines.push(`• Не удалось определить марку у ${progress.unmatched} кандидатов`);
  return `📈 <b>Квоты текущего прогона</b>\nRun: <code>${runId}</code>\nПлан поиска: ${plannedCandidates} кандидатов · найдено ${candidateCount}\nОбработано ${processed} · ждут ${queued} · в работе ${leased}\nЭто план кандидатов, а не число публикаций.\n\n${lines.join("\n")}`;
}
