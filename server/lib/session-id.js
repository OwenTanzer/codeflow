// Session ID validation — MOO-72 Commit 1B.
//
// sessionId is optional and diagnostic-only (log/response correlation
// across a client's repository->file->function drill-down chain), not a
// field anything functional depends on. A malformed value is therefore
// never a hard validation failure -- normalized to null instead -- but a
// well-formed one must be recognizable both when normalizing a validated
// request and when echoing a value straight off a raw, not-yet-validated
// body (e.g. on an error response for some other field). One shared check
// for both call sites, rather than two independent regexes that could
// drift apart.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidSessionId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
