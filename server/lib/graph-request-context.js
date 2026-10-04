// Shared request identity for the repository, file and function graph routes.
import { normalizeContext } from '../../src/graph-ir/githubContext.js';

/**
 * Build the normalized AnalysisContext for this request from the original
 * (pre-resolution) request plus what analyzeGithubRepo actually resolved --
 * sourceOwner/sourceRepo only ever differ from the requested owner/repo for
 * a forked PR (see github-analyzer-bridge.js's resolveRef doc comment), and
 * normalizeContext only accepts them in pr mode.
 */
export function buildRequestContext(request, resolved) {
  const isPr = request.pr != null;
  return normalizeContext({
    owner: request.owner,
    repo: request.repo,
    mode: isPr ? 'pr' : request.ref ? 'branch' : 'repository',
    ref: !isPr && request.ref ? request.ref : undefined,
    prNumber: isPr ? request.pr : undefined,
    resolvedSha: resolved.resolvedSha,
    ...(isPr ? { sourceOwner: resolved.sourceOwner, sourceRepo: resolved.sourceRepo } : {}),
  });
}

/**
 * Cache-key option fields that distinguish two requests which resolve to
 * the same commit but must not share a cached response — MOO-72 Commit 2.
 *
 * contextIdentityKey() (which buildCacheKey hashes) keys on
 * sourceOwner/sourceRepo@resolvedSha, deliberately omitting mode and ref:
 * that's the right rule for "is this the same source content", but it is
 * *not* sufficient for caching a whole response. A default-branch request
 * and an explicit `ref: 'main'` request can resolve to the identical SHA
 * while requiring different `graph.context` values (mode 'repository' vs
 * 'branch', ref null vs 'main') in what gets served back. Folding both into
 * the key keeps those entries distinct without changing the shared
 * contextIdentityKey contract every other consumer depends on.
 * @param {import('../../src/graph-ir/githubContext.js').AnalysisContext} context
 * @returns {{requestMode: string, requestRef?: string}}
 */
export function cacheKeyRequestIdentity(context) {
  return {
    requestMode: context.mode,
    ...(context.mode === 'branch' ? { requestRef: context.ref } : {}),
  };
}
