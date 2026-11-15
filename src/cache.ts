/**
 * Small in-memory LRU + TTL cache for identical search queries.
 * Single-threaded JS runtime, so plain Map mutation is safe.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>()

  constructor(private readonly maxEntries: number) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    // Refresh insertion position for LRU eviction.
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit.value
  }

  set(key: string, value: V, ttlSeconds: number): void {
    if (this.maxEntries <= 0 || ttlSeconds <= 0) return
    this.entries.delete(key)
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
  }
}
