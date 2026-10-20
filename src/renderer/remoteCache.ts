/**
 * A small time-bounded cache of successful answers, so going back to a tab
 * shows its data at once instead of a spinner and a new request. Only real
 * data is stored (never an error), and an entry older than its ttl is gone.
 */
const DEFAULT_MAX_ENTRIES = 64;

export function createRemoteCache<V>(
  ttlMs: number,
  now: () => number = Date.now,
  maxEntries: number = DEFAULT_MAX_ENTRIES,
) {
  const entries = new Map<string, { expiresAt: number; value: V }>();

  return {
    get(key: string): V | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: V): void {
      entries.delete(key);
      entries.set(key, { expiresAt: now() + ttlMs, value });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    delete(key: string): void {
      entries.delete(key);
    },
  };
}
