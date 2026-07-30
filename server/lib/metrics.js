// In-process request-outcome counters — MOO-72 Commit 3.
//
// Deliberately small: one count/sum/max bucket per (layer, resultState,
// cacheStatus), enough to spot a slow or failing layer from Railway's
// stdout log stream without building real metrics infrastructure this
// commit doesn't need. Process-local and cumulative-since-start, same
// lifetime scope as GraphCache (server/lib/graph-cache.js) -- lost on
// restart/redeploy, never shared across replicas.

const LAYERS = new Set(['repository', 'file', 'function']);

// Terminal outcomes only -- a request must land in exactly one of these
// exactly once. Nonterminal, in-flight events (e.g. a pyan3-degraded
// warning that precedes the request's own eventual completion log) are not
// part of this vocabulary and must never call record().
//
// PR review finding: 'cache_hit' does not belong here. Cache provenance
// and response quality are independent -- graph-repository.js
// deliberately caches Python-tree-sitter-degraded graphs (see its own
// "nothing here worth refusing to cache" comment), so a later request
// served from that entry is still a partial_success, not some fourth
// unrelated state that erases the degradation. resultState always answers
// "how good was this response"; cacheStatus (below) separately answers
// "did this come from cache."
const RESULT_STATES = new Set([
  'success',
  'partial_success',
  'timeout',
  'cancelled',
  'validation_error',
  'not_allowlisted',
  'github_error',
  'parser_failure',
  'contract_violation',
  'dependency_unavailable',
  'internal_error',
  // MOO-72 Commit 8: the concurrency limiter rejected this request before
  // any expensive work started -- a distinct failure-hotspot signal from
  // 'timeout' (which only ever fires after work has actually begun).
  'at_capacity',
]);

// Only success/partial_success ever reach a cache lookup in any of the
// three routes -- every other resultState is decided before or instead of
// a cache check (validation, allowlist, timeout, github_error, etc. all
// return before cache.get() runs, or never call it at all). cacheStatus is
// therefore optional; omit it for those states rather than forcing a
// meaningless 'miss' onto branches that structurally never touch the cache.
const CACHE_STATUSES = new Set(['hit', 'miss']);

export class Metrics {
  constructor() {
    this._buckets = new Map();
    this._windowStartedAt = new Date().toISOString();
  }

  /**
   * Record one terminal request outcome. Invalid input (a typo'd layer,
   * resultState, or cacheStatus, or a non-finite/negative duration) is
   * silently dropped rather than manufacturing a stray bucket -- a typo
   * should be invisible in metrics, not a permanent new row.
   * @param {{layer: string, resultState: string, durationMs: number, cacheStatus?: 'hit'|'miss'}} outcome
   */
  record({ layer, resultState, durationMs, cacheStatus }) {
    if (!LAYERS.has(layer)) return;
    if (!RESULT_STATES.has(resultState)) return;
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return;
    if (cacheStatus != null && !CACHE_STATUSES.has(cacheStatus)) return;

    const normalizedCacheStatus = cacheStatus != null ? cacheStatus : null;
    const key = `${layer}:${resultState}:${normalizedCacheStatus ?? 'n/a'}`;
    const bucket = this._buckets.get(key) || {
      layer,
      resultState,
      cacheStatus: normalizedCacheStatus,
      count: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    };
    bucket.count += 1;
    bucket.totalDurationMs += durationMs;
    bucket.maxDurationMs = Math.max(bucket.maxDurationMs, durationMs);
    this._buckets.set(key, bucket);
  }

  /**
   * A plain-object summary suitable for a single structured log line.
   * `scope`/`windowStartedAt` make clear these are cumulative-since-start
   * counters, not a rolling window -- so a periodic 5-minute summary log
   * isn't mistaken for "the last 5 minutes."
   */
  snapshot() {
    return {
      scope: 'process_lifetime',
      windowStartedAt: this._windowStartedAt,
      snapshotAt: new Date().toISOString(),
      buckets: Array.from(this._buckets.values()).map((b) => ({
        layer: b.layer,
        resultState: b.resultState,
        cacheStatus: b.cacheStatus,
        count: b.count,
        avgDurationMs: b.count > 0 ? Math.round((b.totalDurationMs / b.count) * 100) / 100 : 0,
        maxDurationMs: b.maxDurationMs,
      })),
    };
  }
}
