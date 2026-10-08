export type EncarEndpoint = "options" | "inspection" | "diagnosis" | "insurance" | "history" | "history_availability";

export type EndpointState =
  | "ok"
  | "confirmed_empty"
  | "confirmed_unavailable"
  | "not_found"
  | "auth_error"
  | "blocked"
  | "rate_limited"
  | "transient_error"
  | "http_error"
  | "invalid_payload"
  | "identity_mismatch"
  | "skipped";

export type EndpointOutcome = {
  endpoint: EncarEndpoint;
  state: EndpointState;
  httpStatus: number | null;
  attempts: number;
  observedAt: string;
  retryable: boolean;
  payload: unknown | null;
  reasonCode: string;
  requestedCanonicalId?: string;
  requestedVehicleNo?: string;
};

type Probe = {
  endpoint: EncarEndpoint;
  httpStatus?: number | null;
  payload?: unknown;
  error?: unknown;
  attempts?: number;
  canonicalId?: string;
  vehicleNo?: string;
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

function errorState(error: unknown): EndpointState {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/HTTP 401\b|auth|verification/i.test(message)) return "auth_error";
  if (/HTTP 403\b/i.test(message)) return "blocked";
  if (/HTTP 429\b/i.test(message)) return "rate_limited";
  if (/HTTP (404|410)\b/i.test(message)) return "not_found";
  if (/HTTP 408\b|HTTP 5\d\d\b|timeout|timed out|abort|econn|eai_again|socket|fetch failed/i.test(message)) return "transient_error";
  return "http_error";
}

export function classifyEndpointProbe(probe: Probe): EndpointOutcome {
  const attempts = Math.max(1, Math.floor(probe.attempts ?? 1));
  const httpStatus = probe.httpStatus ?? null;
  let state: EndpointState;
  let payload: unknown | null = probe.payload ?? null;

  if (probe.error !== undefined && probe.error !== null) {
    state = errorState(probe.error);
    payload = null;
  } else if (httpStatus !== null && httpStatus >= 400) {
    state = errorState(new Error(`HTTP ${httpStatus}`));
    if (probe.endpoint === "options" && state === "not_found") state = "confirmed_empty";
    payload = null;
  } else {
    switch (probe.endpoint) {
      case "options":
        state = Array.isArray(payload)
          ? (payload.length ? "ok" : "confirmed_empty")
          : "invalid_payload";
        break;
      case "inspection": {
        const actualId = object(payload).vehicleId;
        if (actualId === undefined || actualId === null) state = "invalid_payload";
        else if (probe.canonicalId && String(actualId) !== probe.canonicalId) state = "identity_mismatch";
        else state = "ok";
        break;
      }
      case "diagnosis": {
        const actualId = object(payload).vehicleId;
        if (!Array.isArray(object(payload).items)) state = "invalid_payload";
        else if (actualId === undefined || actualId === null) state = "invalid_payload";
        else if (probe.canonicalId && String(actualId) !== probe.canonicalId) state = "identity_mismatch";
        else state = "ok";
        break;
      }
      case "insurance": {
        const openData = object(payload).openData;
        state = typeof openData !== "boolean"
          ? "invalid_payload"
          : openData ? "ok" : "confirmed_unavailable";
        break;
      }
      case "history":
        if (!Array.isArray(object(payload).accidentHistoryResponse)) state = "invalid_payload";
        else state = (object(payload).accidentHistoryResponse as unknown[]).length ? "ok" : "confirmed_empty";
        break;
      case "history_availability":
        if (typeof object(payload).available !== "boolean") state = "invalid_payload";
        else state = object(payload).available ? "ok" : "confirmed_unavailable";
        break;
    }
  }

  if (state === "ok" || state === "confirmed_empty" || state === "confirmed_unavailable") {
    const values = object(payload);
    const returnedId = values.vehicleId ?? values.carId ?? values.canonicalVehicleId;
    const returnedNo = values.vehicleNo;
    if ((returnedId !== undefined && probe.canonicalId && String(returnedId) !== probe.canonicalId)
      || (returnedNo !== undefined && probe.vehicleNo && String(returnedNo) !== probe.vehicleNo)) state = "identity_mismatch";
  }
  if (probe.endpoint === "options" && state === "not_found") state = "confirmed_empty";
  const retryable = state === "transient_error";
  return {
    endpoint: probe.endpoint,
    state,
    httpStatus,
    attempts,
    observedAt: new Date().toISOString(),
    retryable,
    payload,
    reasonCode: `${probe.endpoint}_${state}`,
    requestedCanonicalId: probe.canonicalId,
    requestedVehicleNo: probe.vehicleNo,
  };
}

export function shouldRetryEndpoint(outcome: EndpointOutcome, attempt: number, maxAttempts: number) {
  return outcome.retryable && attempt < maxAttempts;
}

export function isEndpointCircuitBreaker(outcome: EndpointOutcome) {
  return outcome.state === "blocked" || outcome.state === "rate_limited";
}
