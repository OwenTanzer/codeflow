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
// comment): for a branch/commit-mode parent graph, pass its exact
// resolvedSha as `ref`, not a branch name, so a branch move between the
// repository request and this one can't silently switch what gets
// analyzed.
//
// PR review finding: for a *forked* PR's parent graph, `owner`/`repo` must
// be the requested BASE repository (AnalysisContext's own owner/repo),
// never sourceOwner/sourceRepo (the resolved fork) — the server's
// allowlist check applies to whatever `owner`/`repo` this request sends,
// and a contributor's fork is never itself the allowlisted repository.
// For PR mode, send `pr` (the PR number) instead of `ref`; the server's
// own resolveRef() already knows how to recover the fork/head SHA from
// owner+repo+pr, exactly like the (currently client-unused) repository
// endpoint already does.
//
// PR review follow-up: a PR-mode request always re-resolves the PR's
// *current* head server-side (since no `ref` is sent), so without telling
// the server what revision this graph was actually built from, a PR
// receiving a new commit between the repository graph loading and a file
// drill-down would silently analyze a different revision. `expectedResolvedSha`/
// `expectedSourceOwner`/`expectedSourceRepo` (sent only in PR mode, where
// this drift is actually possible) let the server reject a stale
// drill-down instead.

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
 * @param {string} input.owner - the requested BASE repository owner (AnalysisContext.owner, never sourceOwner)
 * @param {string} input.repo - the requested BASE repository name (AnalysisContext.repo, never sourceRepo)
 * @param {string} input.resolvedSha - the parent graph's pinned revision, sent as `ref` when `pr` is not set, or as `expectedResolvedSha` (a check, not a fetch parameter) when it is
 * @param {number} [input.pr] - the PR number, when the parent graph's context.mode === 'pr'; takes precedence over resolvedSha as the fetch parameter, letting the server re-resolve the fork/head sha itself
 * @param {string} [input.sourceOwner] - the parent graph's resolved source owner, sent as `expectedSourceOwner` only in PR mode
 * @param {string} [input.sourceRepo] - the parent graph's resolved source repo, sent as `expectedSourceRepo` only in PR mode
 * @param {string} input.path
 * @param {string|null} [input.depth]
 * @param {string} input.serverAuthToken
 * @returns {{url: string, init: RequestInit}}
 */
export function buildGraphFileRequest({ owner, repo, resolvedSha, pr, sourceOwner, sourceRepo, path, depth, serverAuthToken }) {
  const body = { owner, repo, path, depth: depth || undefined };
  if (pr != null) {
    body.pr = pr;
    body.expectedResolvedSha = resolvedSha;
    body.expectedSourceOwner = sourceOwner;
    body.expectedSourceRepo = sourceRepo;
  } else {
    body.ref = resolvedSha;
  }
  return {
    url: '/api/graph/file',
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + serverAuthToken,
      },
      body: JSON.stringify(body),
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
