// Shared authenticated server-request plumbing — MOO-71 Commit 7.
//
// Extracted from src/state/graphFileClient.js (MOO-70 Commit 8), which was
// the only caller of the private server's auth-gated /api/* routes and so
// built its `Authorization: Bearer` header inline. Commit 7 adds a second
// caller (src/state/graphFunctionClient.js), and both panels must go
// through one authenticated request helper rather than independently
// constructing headers — otherwise the token's handling (and any future
// change to it) is duplicated per layer, which is exactly how one of the
// two ends up diverging.
//
// Deliberately NOT a general credential-management or API-client layer.
// This is application-scoped ephemeral auth state: the token is passed in
// per call from React memory, never stored, cached, or read from
// storage here. It must never reach NavigationHistory, route state, URLs,
// GraphIR, diagnostics, or logs — this module is the chokepoint that keeps
// that property checkable in one place instead of per call site.

/**
 * Base class for the per-endpoint client errors. Carries the fields every
 * caller needs to distinguish a rejected token (401) from an unsupported
 * input (403/422) from a genuine server failure, without each endpoint
 * client re-deriving them from the response body.
 */
export class ServerRequestError extends Error {
  constructor(message, { status, category, diagnostics, retryable, retryAfterMs } = {}) {
    super(message);
    this.name = 'ServerRequestError';
    this.status = status;
    this.category = category;
    this.diagnostics = diagnostics || [];
    // MOO-72 Commit 4: whether a Retry control should be offered for this
    // failure. See mapServerJsonResponse for how this is derived.
    this.retryable = !!retryable;
    this.retryAfterMs = retryAfterMs ?? null;
  }
}

/**
 * The single place `Authorization: Bearer` is constructed. Endpoint clients
 * shape their own request body (which fields an endpoint takes is their
 * business) and hand it here for transport concerns.
 *
 * Keys whose value is `undefined` are dropped by JSON.stringify, which is
 * how endpoint clients omit optional fields — preserved from
 * graphFileClient.js's original behavior rather than changed.
 *
 * @param {object} input
 * @param {string} input.path - server route path, e.g. '/api/graph/file'
 * @param {object} input.body - the endpoint-specific request body
 * @param {string} input.serverAuthToken - the private server's AUTH_TOKEN, held only in React memory
 * @param {AbortSignal} [input.signal] - MOO-72 Commit 1B: optional, threaded straight into fetch's RequestInit; undefined is a no-op
 * @returns {{url: string, init: RequestInit}}
 */
export function buildServerJsonRequest({ path, body, serverAuthToken, signal }) {
  return {
    url: path,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + serverAuthToken,
      },
      body: JSON.stringify(body),
      signal,
    },
  };
}

/**
 * Shared response mapping: return the parsed body on success, or throw the
 * endpoint's own error subclass carrying status/category/diagnostics/retryable.
 *
 * MOO-72 Commit 4: a structured route diagnostic isn't the only shape a
 * failure response can take -- a 429 from the server-wide rate limiter, or
 * an unstructured 5xx from a proxy/Railway failure in front of the app,
 * carry no `diagnostics[0]` at all. Precedence: an explicit boolean on the
 * diagnostic wins; otherwise 429 defaults retryable (reading `Retry-After`
 * if present); otherwise any other 5xx defaults retryable (conservative --
 * an unstructured server failure is more often transient than not);
 * anything else defaults non-retryable.
 *
 * @param {boolean} ok
 * @param {number} status
 * @param {object|null} body - null when the response body wasn't valid JSON
 * @param {typeof ServerRequestError} ErrorClass - the endpoint's own error subclass, so `instanceof` checks at call sites stay specific
 * @param {Headers} [headers]
 * @returns {object} the parsed body (an AdapterResult, for the graph endpoints)
 * @throws {ServerRequestError}
 */
export function mapServerJsonResponse(ok, status, body, ErrorClass, headers) {
  if (!ok) {
    const safeBody = body || {};
    const diagnostic = Array.isArray(safeBody.diagnostics) ? safeBody.diagnostics[0] : null;
    let retryable;
    if (diagnostic && typeof diagnostic.retryable === 'boolean') {
      retryable = diagnostic.retryable;
    } else if (status === 429) {
      retryable = true;
    } else if (status >= 500) {
      retryable = true;
    } else {
      retryable = false;
    }
    const retryAfterHeader = status === 429 && headers && typeof headers.get === 'function' ? headers.get('Retry-After') : null;
    const retryAfterMs = retryAfterHeader && !Number.isNaN(Number(retryAfterHeader)) ? Number(retryAfterHeader) * 1000 : null;
    throw new ErrorClass(safeBody.error || `Request failed with status ${status}`, {
      status,
      category: diagnostic && diagnostic.category,
      diagnostics: safeBody.diagnostics,
      retryable,
      retryAfterMs,
    });
  }
  return body;
}

/**
 * The one network path both graph clients go through. Takes an
 * already-built request rather than re-deriving one, so each endpoint
 * client keeps ownership of its own body shaping (which fields it sends,
 * and the `ref`-vs-`pr` revision-pinning decision) while transport, auth
 * headers, and error mapping stay here.
 *
 * MOO-72 Commit 4: `fetch()` itself rejecting (DNS failure, connection
 * refused, a Railway/proxy hiccup that never reaches the app) is not the
 * same as the app responding with an error status, and must not be
 * misclassified as non-retryable just because it produced no diagnostic --
 * inability to reach the server is one of the most obviously transient
 * failures there is. An AbortError (our own cancellation/supersession
 * signal firing) is the one exception: it rethrows unchanged so existing
 * call sites' `isCurrent`-style swallowing keeps working untouched, since
 * an aborted request is never shown to the user at all.
 *
 * @param {object} input
 * @param {string} input.url
 * @param {RequestInit} input.init - from buildServerJsonRequest
 * @param {typeof ServerRequestError} input.ErrorClass
 * @returns {Promise<object>} the parsed body
 * @throws {ServerRequestError}
 */
export async function sendServerJsonRequest({ url, init, ErrorClass }) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ErrorClass('Could not reach the CodeFlow server', {
      status: 0,
      category: 'network_error',
      diagnostics: [],
      retryable: true,
    });
  }
  const parsed = await res.json().catch(() => null);
  return mapServerJsonResponse(res.ok, res.status, parsed, ErrorClass, res.headers);
}
