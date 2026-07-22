// Client-side fetch wrapper for POST /api/graph/file — MOO-70 Commit 8.
//
// The first client integration with the private server's auth-gated API:
// repository-layer analysis today runs entirely client-side against
// GitHub directly (index.html's finishAnalysis(), using a user-entered
// GitHub PAT), with zero existing fetch/auth plumbing for the server's
// own AUTH_TOKEN-gated /api/* routes. pyan3 is a Python subprocess with
// no client-side equivalent, so the file layer has no choice but to call
// the server — this is deliberately the minimal wrapper needed for that
// one call, not a general private-server-auth overhaul.
//
// Revision-pinning convention (see server/routes/graph-file.js's own doc
// comment): pass the parent graph's exact resolvedSha as `ref`, not a
// branch name, so a branch move between the repository request and this
// one can't silently switch what gets analyzed.

export class GraphFileClientError extends Error {
  constructor(message, { status, category, diagnostics } = {}) {
    super(message);
    this.name = 'GraphFileClientError';
    this.status = status;
    this.category = category;
    this.diagnostics = diagnostics || [];
  }
}

/**
 * Build the request init object for POST /api/graph/file — extracted so
 * the request-shaping logic is testable without a real fetch.
 * @param {object} input
 * @param {string} input.owner
 * @param {string} input.repo
 * @param {string} input.resolvedSha - the parent graph's pinned revision, sent as `ref`
 * @param {string} input.path
 * @param {string|null} [input.depth]
 * @param {string} input.serverAuthToken
 * @returns {{url: string, init: RequestInit}}
 */
export function buildGraphFileRequest({ owner, repo, resolvedSha, path, depth, serverAuthToken }) {
  return {
    url: '/api/graph/file',
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + serverAuthToken,
      },
      body: JSON.stringify({ owner, repo, ref: resolvedSha, path, depth: depth || undefined }),
    },
  };
}

/**
 * Map a fetch Response's parsed JSON body into either the successful
 * AdapterResult or a thrown GraphFileClientError — extracted so the
 * error-mapping logic is testable without a real network round-trip.
 * @param {boolean} ok
 * @param {number} status
 * @param {object} body
 * @returns {object} the AdapterResult
 * @throws {GraphFileClientError}
 */
export function mapGraphFileResponse(ok, status, body) {
  if (!ok) {
    const diagnostic = Array.isArray(body.diagnostics) ? body.diagnostics[0] : null;
    throw new GraphFileClientError(body.error || `Request failed with status ${status}`, {
      status,
      category: diagnostic && diagnostic.category,
      diagnostics: body.diagnostics,
    });
  }
  return body;
}

/**
 * @param {object} input - see buildGraphFileRequest
 * @returns {Promise<object>} the parsed AdapterResult
 */
export async function fetchFileGraph(input) {
  const { url, init } = buildGraphFileRequest(input);
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  return mapGraphFileResponse(res.ok, res.status, body);
}
