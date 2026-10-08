import { CATALOG_POLICY } from "./catalog-policy";
import { classifyEndpointProbe, shouldRetryEndpoint, type EncarEndpoint } from "./endpoint-outcomes";

export async function requestEndpointWithRetry(input: {
  endpoint: EncarEndpoint;
  canonicalId?: string;
  vehicleNo?: string;
  maxAttempts?: number;
  delayMs?: number;
  signal?: AbortSignal;
  probe: (attempt: number) => Promise<{httpStatus?: number | null; payload?: unknown; error?: unknown}>;
  wait: (milliseconds: number) => Promise<unknown>;
}) {
  const max=Math.min(CATALOG_POLICY.maxEndpointAttempts,Math.max(1,input.maxAttempts??CATALOG_POLICY.maxEndpointAttempts));
  for(let attempt=1;attempt<=max;attempt++) {
    if(input.signal?.aborted) throw input.signal.reason ?? new Error("worker_lock_lost");
    let probe: Awaited<ReturnType<typeof input.probe>>;
    try {probe=await input.probe(attempt);} catch(error) {
      if(input.signal?.aborted) throw input.signal.reason ?? error;
      probe={error};
    }
    if(input.signal?.aborted) throw input.signal.reason ?? new Error("worker_lock_lost");
    const outcome=classifyEndpointProbe({endpoint:input.endpoint,canonicalId:input.canonicalId,vehicleNo:input.vehicleNo,attempts:attempt,...probe});
    if(!shouldRetryEndpoint(outcome,attempt,max)) return outcome;
    await input.wait(Math.min((input.delayMs??CATALOG_POLICY.requestDelayMs)*attempt,30000));
  }
  throw Error("Unreachable endpoint retry state");
}
