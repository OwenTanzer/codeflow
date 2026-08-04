// Client-side fetch wrapper for POST /api/graph/repository — MOO-72 Commit 1A.
//
// Mirrors src/state/graphFileClient.js/graphFunctionClient.js: same shared
// authenticated request helper (src/state/serverRequest.js), same error
// shape. This is the repository layer's first real integration with the
// server's own /api/graph/repository route -- previously the repository
// layer ran entirely client-side against GitHub directly (index.html's
// finishAnalysis(), using a user-entered GitHub PAT); see
// docs/upstream-compatibility.md-equivalent reasoning in
// src/adapters/repositoryGraphToViewModel.js for why that path is being
// replaced now.
//
// Unlike the file/function clients, there is no parent revision to inherit
// or pin against -- the repository request *is* the root of the revision
// chain (its own resolvedSha becomes what file/function requests pin
// against next), so this client sends only `ref`/`pr` (a branch name or PR
// number, never a pre-resolved SHA) and no expectedResolvedSha triple.
import { ServerRequestError, buildServerJsonRequest, mapServerJsonResponse, sendServerJsonRequest } from './serverRequest.js';

export class GraphRepositoryClientError extends ServerRequestError {
  constructor(message, options) {
    super(message, options);
    this.name = 'GraphRepositoryClientError';
  }
}

/**
 * Build the request init object for POST /api/graph/repository — extracted
 * so the request-shaping logic is testable without a real fetch.
 * @param {object} input
 * @param {string} input.owner
 * @param {string} input.repo
 * @param {string} [input.ref] - a branch name or commit SHA; omit for the default branch
 * @param {number} [input.pr] - a PR number, mutually exclusive with ref
 * @param {string[]} [input.excludePatterns] - raw exclude-pattern strings (validated/capped server-side)
 * @param {string} input.appPassword
 * @param {string} [input.sessionId] - MOO-72 Commit 1B: correlates this request with the rest of one drill-down chain
 * @param {AbortSignal} [input.signal] - MOO-72 Commit 1B: forwarded straight to fetch
 * @returns {{url: string, init: RequestInit}}
 */
export function buildGraphRepositoryRequest({ owner, repo, ref, pr, excludePatterns, appPassword, sessionId, signal }) {
  const body = { owner, repo, ref: ref || undefined, pr: pr || undefined, excludePatterns: excludePatterns && excludePatterns.length ? excludePatterns : undefined, sessionId };
  return buildServerJsonRequest({ path: '/api/graph/repository', body, appPassword, signal });
}

/**
 * Map a fetch Response's parsed JSON body into either the successful
 * AdapterResult or a thrown GraphRepositoryClientError — extracted so the
 * error-mapping logic is testable without a real network round-trip.
 * @param {boolean} ok
 * @param {number} status
 * @param {object} body
 * @returns {object} the AdapterResult
 * @throws {GraphRepositoryClientError}
 */
export function mapGraphRepositoryResponse(ok, status, body) {
  return mapServerJsonResponse(ok, status, body, GraphRepositoryClientError);
}

/**
 * @param {object} input - see buildGraphRepositoryRequest
 * @returns {Promise<object>} the parsed AdapterResult
 */
export async function fetchRepositoryGraph(input) {
  const { url, init } = buildGraphRepositoryRequest(input);
  return sendServerJsonRequest({ url, init, ErrorClass: GraphRepositoryClientError });
}
