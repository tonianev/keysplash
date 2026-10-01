/**
 * A small least-recently-used cache with an optional total cost limit
 * (used for sprite canvases, where cost = bytes).
 */
interface LruEntry<V> {
  value: V;
  cost: number;
}

export class LruCache<K, V> {
  private readonly map = new Map<K, LruEntry<V>>();
  private totalCost = 0;

  constructor(
    readonly maxEntries: number,
    readonly maxCost: number = Number.POSITIVE_INFINITY,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get cost(): number {
    return this.totalCost;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Re-insert to mark as most recently used (Map keeps insertion order).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, cost = 1): void {
    const old = this.map.get(key);
    if (old) {
      this.totalCost -= old.cost;
      this.map.delete(key);
    }
    this.map.set(key, { value, cost });
    this.totalCost += cost;
    this.evict();
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.totalCost -= entry.cost;
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.totalCost = 0;
  }

  /** Keys from least to most recently used (for tests/debugging). */
  keys(): K[] {
    return [...this.map.keys()];
  }

  private evict(): void {
    while (this.map.size > this.maxEntries || (this.totalCost > this.maxCost && this.map.size > 1)) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }
}
