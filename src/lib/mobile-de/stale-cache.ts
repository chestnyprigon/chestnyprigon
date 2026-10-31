/**
 * Per-instance stale-if-error cache for public, non-personal catalogue reads.
 * A known-good value remains available while the upstream read is unhealthy.
 */
export function createStaleCache<T>(
  freshForMs: number,
  staleForMs: number,
  maxEntries = 64,
  now = () => Date.now(),
) {
  const values = new Map<string, { value: T; freshUntil: number; staleUntil: number }>();
  const pending = new Map<string, Promise<T>>();

  return async (key: string, load: () => Promise<T>): Promise<T> => {
    const time = now();
    const cached = values.get(key);
    if (cached && cached.freshUntil > time) return cached.value;

    const running = pending.get(key);
    if (running) return cached && cached.staleUntil > time ? cached.value : running;

    const task = Promise.resolve().then(load).then((value) => {
      if (!values.has(key) && values.size >= maxEntries) values.delete(values.keys().next().value!);
      const storedAt = now();
      values.set(key, { value, freshUntil: storedAt + freshForMs, staleUntil: storedAt + freshForMs + staleForMs });
      return value;
    }).catch((error: unknown) => {
      if (cached && cached.staleUntil > now()) return cached.value;
      values.delete(key);
      throw error;
    }).finally(() => pending.delete(key));

    pending.set(key, task);
    if (cached && cached.staleUntil > time) return cached.value;
    return task;
  };
}
