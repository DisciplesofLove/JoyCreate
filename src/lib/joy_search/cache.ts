/**
 * Tiny TTL-keyed in-memory cache.
 *
 * Used by JoySearch to cache search results (10 min) and fetched
 * articles (30 min). Process-lifetime only — we explicitly chose
 * NOT to persist these to disk (privacy + freshness).
 */

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<K extends string, V> {
  private store = new Map<K, Entry<V>>();
  private maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  get(key: K): V | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: K, value: V, ttlMs: number): void {
    if (this.store.size >= this.maxEntries) {
      // Evict the oldest insertion (Maps preserve insertion order).
      const firstKey = this.store.keys().next().value as K | undefined;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}
