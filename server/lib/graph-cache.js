// In-process LRU cache for GraphIR results — MOO-72 Commit 2.
//
// Map insertion order gives O(1) LRU tracking: get() refreshes recency by
// deleting and re-inserting the entry; set() evicts the first Map entry
// (the least-recently-used one) until both item-count and byte-size
// constraints are satisfied. This is intentionally a process-local,
// single-instance store — cleared on every restart or Railway deploy,
// never shared across replicas. Multi-replica deployments require Redis or
// a similar shared store; that is explicitly out of scope.
//
// What gets stored: the raw GraphIR `graph` object (not the full
// AdapterResult envelope). Route handlers call buildAdapterResult()
// freshly on every response, including cache hits, so timing, cache.hit,
// and other request-specific fields are never stale.

export class GraphCache {
  /**
   * @param {{maxItems: number, maxBytes: number, ttlMs: number, enabled: boolean}} options
   */
  constructor({ maxItems, maxBytes, ttlMs, enabled }) {
    this._maxItems = maxItems;
    this._maxBytes = maxBytes;
    this._ttlMs = ttlMs;
    this._enabled = enabled;
    this._map = new Map();
    this._totalBytes = 0;
  }

  /**
   * Return the stored graph for `key`, or null on miss/expiry.
   * Refreshes the entry's LRU position (delete + reinsert) on hit.
   * @param {string} key
   * @returns {object|null}
   */
  get(key) {
    if (!this._enabled) return null;
    const entry = this._map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._totalBytes -= entry.bytes;
      this._map.delete(key);
      return null;
    }
    // Move to end = mark as most recently used
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.graph;
  }

  /**
   * Store `graph` under `key`. Evicts LRU entries until both item-count and
   * byte-size constraints are satisfied. Skips insertion (with a console
   * warning) when the entry alone exceeds maxBytes. Refreshes LRU recency
   * if the key already exists.
   * @param {string} key
   * @param {object} graph
   */
  set(key, graph) {
    if (!this._enabled) return;
    const bytes = JSON.stringify(graph).length;
    if (bytes > this._maxBytes) {
      // Entry is too large to ever fit — don't evict everything just to fail
      console.warn(`[graph-cache] entry for key ${key} is ${bytes} bytes, exceeds maxBytes ${this._maxBytes}; skipping`);
      return;
    }
    // Remove any existing entry for this key first so re-insertion puts it
    // at the Map's end (most recently used) rather than keeping its old position
    if (this._map.has(key)) {
      this._totalBytes -= this._map.get(key).bytes;
      this._map.delete(key);
    }
    this._map.set(key, { graph, expiresAt: Date.now() + this._ttlMs, bytes });
    this._totalBytes += bytes;
    // Evict LRU entries until both constraints are satisfied
    while (this._map.size > this._maxItems || this._totalBytes > this._maxBytes) {
      const firstKey = this._map.keys().next().value;
      const evicted = this._map.get(firstKey);
      this._totalBytes -= evicted.bytes;
      this._map.delete(firstKey);
    }
  }

  /** Clear all entries. Primarily for tests. */
  clear() {
    this._map.clear();
    this._totalBytes = 0;
  }

  /** Current number of entries. */
  get size() {
    return this._map.size;
  }

  /** Current estimated byte usage across all stored entries. */
  get totalBytes() {
    return this._totalBytes;
  }
}
