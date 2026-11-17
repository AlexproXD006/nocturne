/** Tiny insertion-ordered LRU cache. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>()

  constructor(private readonly max: number) {
    if (!(max > 0)) throw new Error('LRU size must be positive')
  }

  get size(): number {
    return this.map.size
  }

  /** Keys from least to most recently used. Does not affect recency. */
  keys(): K[] {
    return [...this.map.keys()]
  }

  /** Reads without touching recency. */
  peek(key: K): V | undefined {
    return this.map.get(key)
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as V
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K
      this.map.delete(oldest)
    }
    return this
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }
}
