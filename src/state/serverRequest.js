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
  constructor(message, { status, category, diagnostics } = {}) {
    super(message);
    this.name = 'ServerRequestError';
    this.status = status;
    this.category = category;
    this.diagnostics = diagnostics || [];
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
 * endpoint's own error subclass carrying status/category/diagnostics.
 *
 * @param {boolean} ok
 * @param {number} status
 * @param {object} body
 * @param {typeof ServerRequestError} ErrorClass - the endpoint's error subclass, so `instanceof` checks at call sites stay specific
 * @returns {object} the parsed body (an AdapterResult, for the graph endpoints)
 * @throws {ServerRequestError}
 */
export function mapServerJsonResponse(ok, status, body, ErrorClass) {
  if (!ok) {
    const diagnostic = Array.isArray(body.diagnostics) ? body.diagnostics[0] : null;
    throw new ErrorClass(body.error || `Request failed with status ${status}`, {
      status,
      category: diagnostic && diagnostic.category,
      diagnostics: body.diagnostics,
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
 * @param {object} input
 * @param {string} input.url
 * @param {RequestInit} input.init - from buildServerJsonRequest
 * @param {typeof ServerRequestError} input.ErrorClass
 * @returns {Promise<object>} the parsed body
 * @throws {ServerRequestError}
 */
export async function sendServerJsonRequest({ url, init, ErrorClass }) {
  const res = await fetch(url, init);
  const parsed = await res.json().catch(() => ({}));
  return mapServerJsonResponse(res.ok, res.status, parsed, ErrorClass);
}
