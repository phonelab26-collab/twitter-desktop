const MAX_ENTRIES = 64;

/**
 * A small time-bounded cache for the REST trends, which X limits to 15 calls
 * per 15 minutes. Only successful values are kept: a failure is never served
 * again from the cache, and concurrent callers share one pending request.
 */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { expiresAt: number; value: Promise<V> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: K, load: () => Promise<V>): Promise<V> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    this.evictExpired();

    const value = load();
    const entry = { expiresAt: this.now() + this.ttlMs, value };
    this.entries.set(key, entry);
    value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return value;
  }

  /** Expired entries are dropped, and the oldest beyond MAX_ENTRIES: memory stays bounded. */
  private evictExpired(): void {
    const time = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= time) this.entries.delete(key);
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
