/** Stop only after sustained operational failures across a meaningful sample.
 * Identity conflicts are safely isolated by the worker and are not transport failures.
 */
export const FAILURE_WINDOW_SIZE = 10;
export const FAILURE_WINDOW_MIN_ERRORS = 5;

export function appendOperationalFailure(samples: boolean[], failed: boolean) {
  return [...samples, failed].slice(-FAILURE_WINDOW_SIZE);
}

export function shouldPauseForOperationalFailures(samples: boolean[]) {
  return samples.length === FAILURE_WINDOW_SIZE
    && samples.filter(Boolean).length >= FAILURE_WINDOW_MIN_ERRORS;
}

/** Individual data defects must not trip the transport circuit breaker. */
export function isOperationalFailure(failureClass?: string) {
  return /^(transient_request|endpoint_transient_error|auth_error|blocked|rate_limited|endpoint_auth_error|endpoint_blocked|endpoint_rate_limited)$/.test(failureClass ?? "");
}
