/** Approved parameters for the local catalogue pipeline. Prices have no range filter. */
export const CATALOG_POLICY = Object.freeze({
  version: "2026-10-07.1",
  minYear: 2016,
  maxMileageKm: 190_000,
  maxListingAgeDays: 180,
  minImages: 5,
  optionsRequired: true,
  reportsRequired: false,
  maxEndpointAttempts: 3,
  requestDelayMs: 10_000,
  targetPublications: 1_000,
});

export type DecisionEvidence = {
  code: string;
  explanation: string;
  values: Record<string, unknown>;
  source: string;
  observedAt: string;
};

export function evidence(code: string, explanation: string, values: Record<string, unknown>, source: string): DecisionEvidence {
  return { code, explanation, values, source, observedAt: new Date().toISOString() };
}
