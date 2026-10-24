export type BrandSearchState = {
  manufacturer: string;
  diversityWeight: number;
  publishedCount: number;
  searchOffset: number;
  scannedCount: number;
  candidateCount: number;
  processedCandidates: number;
  conversionRate: number | null;
  exhausted: boolean;
};

export type BrandSearchPlan = BrandSearchState & {
  backlogCandidates: number;
  nextOffset: number;
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

export function planBrandSearch(states: BrandSearchState[]): BrandSearchPlan[] {
  // Brand targets only set the order in which we work through the market.
  // Every configured, non-exhausted brand is searched to the end of its source
  // listing. There is no candidate-pool or publication-count ceiling.
  return states.map((state) => {
    const backlogCandidates = Math.max(0, state.candidateCount - state.processedCandidates);
    return { ...state, backlogCandidates, nextOffset: state.searchOffset };
  });
}
