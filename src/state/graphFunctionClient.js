// Client-side fetch wrapper for POST /api/graph/function — MOO-71 Commit 7.
//
// Mirrors src/state/graphFileClient.js deliberately: same revision-pinning
// convention, same PR-mode drift rejection, same error shape. Both now go
// through src/state/serverRequest.js's shared public-API helper, so
// transport and response mapping stay centralized.
//
// Two real differences from the file client, both dictated by
// server/lib/validate-function-request.js:
//
// 1. `symbolPath` (an array of scope segments, e.g. ['Service', 'run'])
//    identifies the exact function/method within the file. The server
//    matches it against MOO-70's pythonSymbolIndex by *exact array
//    equality* and rejects zero matches (404 unresolved) or more than one
//    (400 ambiguous) rather than tie-breaking — so this client must send
//    the coordinate's symbolPath verbatim, never a name it reconstructed
//    from a node label.
// 2. No `depth` field — depth is meaningless at function granularity
//    (see validate-function-request.js's own comment); the whole
//    control-flow graph of one function is the unit.
//
// The revision-pinning convention is reused verbatim from the file client
// for the same reason, restated because it's the part that silently breaks
// if someone "simplifies" it: send the parent graph's exact resolvedSha as
// `ref` so a branch moving mid-drill-down can't switch what gets analyzed;
// in PR mode send `pr` instead (the server re-resolves the fork/head sha)
// plus expectedResolvedSha/expectedSourceOwner/expectedSourceRepo so a PR
// that received a new commit since the parent graph loaded is rejected
// rather than silently analyzed at a different revision. `owner`/`repo`
// are always the requested BASE repository, never sourceOwner/sourceRepo —
// the server's allowlist check applies to whatever this request sends, and
// a contributor's fork is never itself allowlisted.
import { ServerRequestError, buildServerJsonRequest, mapServerJsonResponse, sendServerJsonRequest } from './serverRequest.js';

export class GraphFunctionClientError extends ServerRequestError {
  constructor(message, options) {
    super(message, options);
    this.name = 'GraphFunctionClientError';
  }
}

/**
 * Build the request init object for POST /api/graph/function — extracted so
 * the request-shaping logic is testable without a real fetch.
 * @param {object} input
 * @param {string} input.owner - the requested BASE repository owner, never sourceOwner
 * @param {string} input.repo - the requested BASE repository name, never sourceRepo
 * @param {string} input.resolvedSha - the parent graph's pinned revision, sent as `ref` when `pr` is not set, or as `expectedResolvedSha` (a check, not a fetch parameter) when it is
 * @param {number} [input.pr] - the PR number when the parent graph's context.mode === 'pr'
 * @param {string} [input.sourceOwner] - sent as `expectedSourceOwner` only in PR mode
 * @param {string} [input.sourceRepo] - sent as `expectedSourceRepo` only in PR mode
 * @param {string} input.path - the file containing the target function
 * @param {string[]} input.symbolPath - the target function/method's exact scope chain, from its SourceCoordinate
 * @param {string} [input.sessionId] - MOO-72 Commit 1B: correlates this request with the rest of one drill-down chain
 * @param {AbortSignal} [input.signal] - MOO-72 Commit 1B: forwarded straight to fetch
 * @returns {{url: string, init: RequestInit}}
 */
export function buildGraphFunctionRequest({ owner, repo, resolvedSha, pr, sourceOwner, sourceRepo, path, symbolPath, sessionId, signal }) {
  const body = { owner, repo, path, symbolPath, sessionId };
  if (pr != null) {
    body.pr = pr;
    body.expectedResolvedSha = resolvedSha;
    body.expectedSourceOwner = sourceOwner;
    body.expectedSourceRepo = sourceRepo;
  } else {
    body.ref = resolvedSha;
  }
  return buildServerJsonRequest({ path: '/api/graph/function', body, signal });
}

/**
 * Map a fetch Response's parsed JSON body into either the successful
 * AdapterResult or a thrown GraphFunctionClientError.
 * @param {boolean} ok
 * @param {number} status
 * @param {object} body
 * @returns {object} the AdapterResult
 * @throws {GraphFunctionClientError}
 */
export function mapGraphFunctionResponse(ok, status, body) {
  return mapServerJsonResponse(ok, status, body, GraphFunctionClientError);
}

/**
 * @param {object} input - see buildGraphFunctionRequest
 * @returns {Promise<object>} the parsed AdapterResult
 */
export async function fetchFunctionGraph(input) {
  const { url, init } = buildGraphFunctionRequest(input);
  return sendServerJsonRequest({ url, init, ErrorClass: GraphFunctionClientError });
}
