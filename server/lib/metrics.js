// In-process request-outcome counters — MOO-72 Commit 3.
//
// Deliberately small: one count/sum/max bucket per (layer, resultState),
// enough to spot a slow or failing layer from Railway's stdout log stream
// without building real metrics infrastructure this commit doesn't need.
// Process-local and cumulative-since-start, same lifetime scope as
// GraphCache (server/lib/graph-cache.js) -- lost on restart/redeploy, never
// shared across replicas.

const LAYERS = new Set(['repository', 'file', 'function']);

// Terminal outcomes only -- a request must land in exactly one of these
// exactly once. Nonterminal, in-flight events (e.g. a pyan3-degraded
// warning that precedes the request's own eventual completion log) are not
// part of this vocabulary and must never call record().
const RESULT_STATES = new Set([
  'success',
  'partial_success',
  'cache_hit',
  'timeout',
  'validation_error',
  'not_allowlisted',
  'github_error',
  'parser_failure',
  'contract_violation',
  'dependency_unavailable',
  'internal_error',
]);

export class Metrics {
  constructor() {
    this._buckets = new Map();
    this._windowStartedAt = new Date().toISOString();
  }

  /**
   * Record one terminal request outcome. Invalid input (a typo'd layer or
   * resultState, or a non-finite/negative duration) is silently dropped
   * rather than manufacturing a stray bucket -- a typo should be invisible
   * in metrics, not a permanent new row.
   * @param {{layer: string, resultState: string, durationMs: number}} outcome
   */
  record({ layer, resultState, durationMs }) {
    if (!LAYERS.has(layer)) return;
    if (!RESULT_STATES.has(resultState)) return;
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return;

    const key = `${layer}:${resultState}`;
    const bucket = this._buckets.get(key) || { layer, resultState, count: 0, totalDurationMs: 0, maxDurationMs: 0 };
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
        count: b.count,
        avgDurationMs: b.count > 0 ? Math.round((b.totalDurationMs / b.count) * 100) / 100 : 0,
        maxDurationMs: b.maxDurationMs,
      })),
    };
  }
}
