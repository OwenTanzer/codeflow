// Analyzer adapter and error contracts — MOO-68 Commit 4.
//
// Every layer adapter (MOO-69's repository adapter, MOO-70's pyan3 bridge,
// MOO-71's CodeVisualizer bridge) returns the same envelope and reports
// failures from the same fixed set of categories, so the server/UI can
// react to "GitHub was unreachable" vs. "the subprocess crashed" vs. "the
// analyzer's own output was malformed" identically regardless of which
// layer produced it — rather than each adapter inventing its own ad hoc
// error shape.
import { validateGraphIR } from './graphIR.js';

/**
 * @typedef {'github_access'|'unsupported_input'|'parser_failure'|'subprocess_failure'|'malformed_analyzer_output'|'timeout'|'renderer_failure'|'internal_error'} ErrorCategory
 */

export const ERROR_CATEGORIES = Object.freeze([
  'github_access',
  'unsupported_input',
  'parser_failure',
  'subprocess_failure',
  'malformed_analyzer_output',
  'timeout',
  'renderer_failure',
  'internal_error',
]);

const CATEGORY_SET = new Set(ERROR_CATEGORIES);

// Same secret-shaped-key pattern server/lib/logger.js already redacts, so a
// diagnostic sanitized here and one logged server-side apply one
// consistent rule rather than two independently-maintained ones.
const SECRET_KEY_PATTERN = /token|authorization|secret|password|api[_-]?key|cookie/i;

// MOO-72 Commit 4: default retryability by category, consulted only when a
// call site doesn't pass an explicit `retryable` (e.g. the github rate-limit
// paths, pyan3's timeout branch). Most categories default to false because
// they describe a deterministic outcome given the same input (a file that
// won't parse, a repo that isn't allowlisted) -- retrying without the input
// changing just repeats the same failure. `timeout` defaults true because
// it's inherently load/environment-dependent. `subprocess_failure` also
// defaults false: a crash/bad-args/missing-binary is far more often
// deterministic than transient; genuinely transient subprocess failures
// (resource pressure) opt in explicitly at their call site instead of
// relying on this default.
export const RETRYABLE_BY_CATEGORY = Object.freeze({
  github_access: false,
  unsupported_input: false,
  parser_failure: false,
  subprocess_failure: false,
  malformed_analyzer_output: false,
  timeout: true,
  renderer_failure: false,
  internal_error: false,
});

export class AdapterError extends Error {
  /**
   * @param {ErrorCategory} category
   * @param {string} message
   * @param {object} [options]
   * @param {object} [options.details] - structured, non-secret context (e.g. {owner, repo, ref})
   * @param {boolean} [options.retryable] - defaults to RETRYABLE_BY_CATEGORY[category] when omitted
   * @param {Error} [options.cause]
   */
  constructor(category, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    if (!CATEGORY_SET.has(category)) {
      throw new TypeError(`Unknown ErrorCategory: ${JSON.stringify(category)} (must be one of ${ERROR_CATEGORIES.join(', ')})`);
    }
    this.name = 'AdapterError';
    this.category = category;
    this.details = options.details || {};
    this.retryable = options.retryable !== undefined ? !!options.retryable : (RETRYABLE_BY_CATEGORY[category] ?? false);
  }
}

/**
 * Recursively redact any object key that looks secret-shaped, and drop
 * stack traces — the shape a diagnostic must be in before it's safe to
 * write to server logs or send to the browser. Applied automatically by
 * `buildAdapterResult` so producing an adapter result can't forget this
 * step; exported separately so it's independently testable.
 * @param {object} diagnostic
 * @returns {object}
 */
export function sanitizeDiagnostic(diagnostic) {
  if (diagnostic instanceof Error) {
    diagnostic = {
      message: diagnostic.message,
      category: diagnostic.category,
      details: diagnostic.details,
      retryable: diagnostic.retryable,
    };
  }
  return sanitizeValue(diagnostic);
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === 'stack') continue;
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : sanitizeValue(val);
    }
    return out;
  }
  return value;
}

/**
 * @typedef {Object} AdapterProvenance
 * @property {string} analyzerName
 * @property {string} analyzerVersion
 * @property {string} fetchedAt - ISO 8601 timestamp
 */

/**
 * @typedef {Object} AdapterTiming
 * @property {string} startedAt - ISO 8601 timestamp
 * @property {number} durationMs
 */

/**
 * @typedef {Object} AdapterCacheInfo
 * @property {string|null} key - the cache key this result was stored/looked up under, or null if caching does not apply
 * @property {boolean} hit
 */

/**
 * @typedef {Object} AdapterResult
 * @property {import('./graphIR.js').GraphIR|null} graph - null only when partial is true and nothing could be produced at all
 * @property {string[]} warnings
 * @property {object[]} diagnostics - sanitized (see sanitizeDiagnostic)
 * @property {AdapterProvenance} provenance
 * @property {AdapterTiming} timing
 * @property {AdapterCacheInfo} cache
 * @property {boolean} partial - true when the adapter produced a degraded/incomplete result rather than a full success
 * @property {string|null} requestId - MOO-72 Commit 1B: the server-generated per-HTTP-request id, echoed here so a
 *   successful response can be correlated the same way an error response already could (via its own requestId field)
 * @property {string|null} sessionId - MOO-72 Commit 1B: the client-supplied, client-generated session id (if any),
 *   echoed back unchanged -- ties this response to the rest of one repository->file->function drill-down chain
 */

export class AdapterResultError extends Error {
  constructor(errors) {
    super('Invalid adapter result:\n' + errors.map((e) => ' - ' + e).join('\n'));
    this.name = 'AdapterResultError';
    this.errors = errors;
  }
}

/**
 * Build and validate an AdapterResult. Partial-success rule: a non-partial
 * result must carry a schema-valid graph; a partial result may either carry
 * a schema-valid (but incomplete/lower-confidence) graph alongside
 * warnings/diagnostics, or carry no graph at all (total failure) — but
 * never an invalid graph in either case. Diagnostics are sanitized here
 * unconditionally, so a caller cannot accidentally skip that step.
 * @param {object} input
 * @returns {AdapterResult}
 */
export function buildAdapterResult(input) {
  const errors = [];
  const graph = input.graph != null ? input.graph : null;

  if (graph != null) {
    const { valid, errors: graphErrors } = validateGraphIR(graph);
    if (!valid) errors.push(...graphErrors.map((e) => `graph: ${e}`));
  } else if (!input.partial) {
    errors.push('graph is required unless partial is true');
  }

  if (!Array.isArray(input.warnings) || input.warnings.some((w) => typeof w !== 'string')) {
    errors.push('warnings must be an array of strings');
  }
  if (!input.provenance || typeof input.provenance.analyzerName !== 'string' || typeof input.provenance.analyzerVersion !== 'string') {
    errors.push('provenance.analyzerName and provenance.analyzerVersion are required strings');
  }
  if (!input.timing || typeof input.timing.startedAt !== 'string' || typeof input.timing.durationMs !== 'number') {
    errors.push('timing.startedAt and timing.durationMs are required');
  }

  if (errors.length > 0) throw new AdapterResultError(errors);

  return {
    graph,
    warnings: input.warnings,
    diagnostics: (input.diagnostics || []).map(sanitizeDiagnostic),
    provenance: {
      analyzerName: input.provenance.analyzerName,
      analyzerVersion: input.provenance.analyzerVersion,
      fetchedAt: input.provenance.fetchedAt || new Date().toISOString(),
    },
    timing: { startedAt: input.timing.startedAt, durationMs: input.timing.durationMs },
    cache: { key: (input.cache && input.cache.key) || null, hit: !!(input.cache && input.cache.hit) },
    partial: !!input.partial,
    requestId: input.requestId ?? null,
    sessionId: input.sessionId ?? null,
  };
}
