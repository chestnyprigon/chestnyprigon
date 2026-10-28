/** Per-instance hard TTL cache for shared catalogue dictionaries, never vehicle prices. */
export function createShortCache<T>(ttlMs: number, maxEntries = 4, now = () => Date.now()) {
  const values = new Map<string, { value: T; expires: number }>();
  const pending = new Map<string, Promise<T>>();
  return async (key: string, load: () => Promise<T>): Promise<T> => {
    const cached = values.get(key);
    if (cached && cached.expires > now()) return cached.value;
    values.delete(key);
    const running = pending.get(key);
    if (running) return running;
    const task = Promise.resolve().then(load).then((value) => {
      if (values.size >= maxEntries) values.delete(values.keys().next().value!);
      values.set(key, { value, expires: now() + ttlMs });
      return value;
    }).finally(() => { pending.delete(key); });
    pending.set(key, task);
    return task;
  };
}
