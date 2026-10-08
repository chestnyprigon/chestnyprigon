export type BrandSearchState = {
  manufacturer: string;
  quotaTarget: number;
  remainingQuota: number;
  searchOffset: number;
  scannedCount: number;
  candidateCount: number;
  processedCandidates: number;
  conversionRate: number | null;
  exhausted: boolean;
};

export type BrandSearchPlan = BrandSearchState & {
  backlogCandidates: number;
  candidateTarget: number;
  candidatesToFind: number;
  nextOffset: number;
  conversionBlocked: boolean;
};

export function allocateProportionally(total: number, weights: Array<{ key: string; weight: number }>) {
  if (!Number.isInteger(total) || total < 0) throw new Error("total must be a nonnegative integer");
  const eligible = weights.filter((item) => Number.isFinite(item.weight) && item.weight > 0);
  if (total === 0 || eligible.length === 0) return new Map<string, number>();
  const sum = eligible.reduce((value, item) => value + item.weight, 0);
  const allocations = eligible.map((item) => {
    const exact = total * item.weight / sum;
    return { key: item.key, value: Math.floor(exact), remainder: exact % 1 };
  });
  let left = total - allocations.reduce((value, item) => value + item.value, 0);
  for (const item of [...allocations].sort((a,b) => b.remainder-a.remainder || a.key.localeCompare(b.key))) {
    if (left-- <= 0) break;
    item.value += 1;
  }
  return new Map(allocations.map((item) => [item.key, item.value]));
}

export function candidatesNeeded(remainingQuota: number, conversionRate: number | null, backlogCandidates: number, pilotPoolTarget: number) {
  if (![remainingQuota, backlogCandidates, pilotPoolTarget].every(Number.isInteger)
    || remainingQuota < 0 || backlogCandidates < 0 || pilotPoolTarget < 0) throw new Error("candidate counts must be nonnegative integers");
  if (remainingQuota === 0) return 0;
  if (conversionRate === 0) return 0;
  if (conversionRate === null) return Math.max(0, pilotPoolTarget - backlogCandidates);
  if (!Number.isFinite(conversionRate) || conversionRate <= 0 || conversionRate > 1) throw new Error("conversionRate must be between 0 and 1");
  return Math.max(0, Math.ceil(remainingQuota / conversionRate) - backlogCandidates);
}

export function planBrandSearch(states: BrandSearchState[], pilotPoolTarget = 50): BrandSearchPlan[] {
  if (!Number.isInteger(pilotPoolTarget) || pilotPoolTarget < 0) throw new Error("pilotPoolTarget must be a nonnegative integer");
  const active = states.filter((state) => state.remainingQuota > 0 && !state.exhausted);
  const pilotStates = active.filter((state) => state.conversionRate === null);
  // Exhausted brands cannot receive more pages, but their existing candidates
  // still belong to the shared pilot pool and must reduce its remaining target.
  const pilotBacklog = states
    .filter((state) => state.remainingQuota > 0 && state.conversionRate === null)
    .reduce((sum, state) => sum + Math.max(0, state.candidateCount - state.processedCandidates), 0);
  const pilotAllocation = allocateProportionally(Math.max(0, pilotPoolTarget - pilotBacklog), pilotStates.map((state) => ({ key: state.manufacturer, weight: state.quotaTarget })));
  return states.map((state) => {
    const backlogCandidates = Math.max(0, state.candidateCount - state.processedCandidates);
    const conversionBlocked = state.conversionRate === 0 && state.remainingQuota > 0;
    const candidateTarget = conversionBlocked ? 0 : state.conversionRate === null
      ? backlogCandidates + (pilotAllocation.get(state.manufacturer) ?? 0)
      : Math.ceil(state.remainingQuota / state.conversionRate);
    const candidatesToFind = state.exhausted || conversionBlocked ? 0 : state.conversionRate === null
      ? pilotAllocation.get(state.manufacturer) ?? 0
      : candidatesNeeded(state.remainingQuota, state.conversionRate, backlogCandidates, pilotPoolTarget);
    return { ...state, backlogCandidates, candidateTarget, candidatesToFind, nextOffset: state.searchOffset, conversionBlocked };
  });
}
