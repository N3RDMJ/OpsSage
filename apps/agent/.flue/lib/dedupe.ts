/**
 * Tiny LRU with a per-entry TTL. Plenty for v1 dedupe (single agent task,
 * 5-minute window). Swap for Redis when we go multi-task.
 */
export class TtlLru<K, V> {
  private readonly map = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number,
  ) {}

  has(key: K): boolean {
    const e = this.map.get(key);
    if (!e) return false;
    if (e.expiresAt < Date.now()) {
      this.map.delete(key);
      return false;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, e);
    return true;
  }

  set(key: K, value: V): void {
    if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
