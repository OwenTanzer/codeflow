// POST /api/graph/repository -- MOO-69 Commit 2.
//
// The GraphIR-returning counterpart to MOO-67's /api/analyze-repo: same
// input validation, allowlist check, and GitHub-backed analysis pipeline
// (reused verbatim, not reimplemented), but responds with an AdapterResult
// (src/graph-ir/adapterResult.js) wrapping a repository-layer GraphIR
// instead of the legacy raw analysis object. Kept as a separate endpoint
// rather than changing /api/analyze-repo's response shape, since that
// would be a breaking change to an already-shipped, already-tested API.
import { validateRepoRequest, ValidationError } from '../lib/validate-repo-request.js';
import { isRepoAllowed } from '../lib/allowlist.js';
import {
  resolveGithubRef,
  fetchAndAnalyzeRepo,
  normalizeExcludePatterns,
  displayExcludePatterns,
  PYTHON_TREE_SITTER_CAPABLE,
  GithubFetchError,
} from '../lib/github-analyzer-bridge.js';
import { createRequestLogger } from '../lib/logger.js';
import { readJsonBody, BodyTooLargeError } from '../lib/http-body.js';
import { adaptRepositoryAnalysis } from '../../src/adapters/repositoryGraphAdapter.js';
import { normalizeContext, AnalysisContextError } from '../../src/graph-ir/githubContext.js';
import { GRAPH_IR_SCHEMA_VERSION } from '../../src/graph-ir/graphIR.js';
import { AdapterError, buildAdapterResult, AdapterResultError, sanitizeDiagnostic } from '../../src/graph-ir/adapterResult.js';
import { buildCacheKey } from '../../src/graph-ir/cacheKey.js';

const ANALYZER = { name: 'codeflow-repository-adapter', version: '1.2.0' };

// MOO-72 Commit 1A review (round 3): server/lib/node-tree-sitter-shim.js's
// installNodeTreeSitter() silently falls back to an undefined
// globalThis.TreeSitter on any init failure (a missing/corrupted
// tree-sitter-wasms install, for example) -- with zero signal and zero
// effect on this route's cache key. Without this, the identical
// repository/revision/options/analyzer-version could be served from
// either a Tree-sitter-backed or a heuristic-fallback analysis depending
// on unpredictable deploy-time state, and Commit 2's durable cache
// couldn't tell the two apart.
//
// Deliberately NOT a fail-loud startup check (the pyan3Adapter.js
// precedent) -- acorn-only/regex-fallback is an intentionally accepted,
// working degraded mode this PR already established in round 1; crashing
// the whole server over a missing Python-specific grammar file would also
// kill JS/TS analysis, for no reason. Instead this reuses the per-file
// `parserProvenance` this same review round already made accurate (see
// src/analyzer.js's extract()) -- the real, already-computed signal of
// what happened, rather than re-checking whether some tree-sitter parser
// object merely exists.
const PYTHON_PATH_PATTERN = /\.(py|pyw|pyi)$/i;

/**
 * @param {import('../../src/graph-ir/graphIR.js').GraphIR} graph
 * @returns {{ pythonFileCount: number, pythonTreeSitterActive: boolean }}
 */
export function derivePythonParserCapability(graph) {
  const pythonNodes = graph.nodes.filter((n) => n.coordinate && PYTHON_PATH_PATTERN.test(n.coordinate.path || ''));
  const pythonTreeSitterActive = pythonNodes.some((n) => {
    const provenance = n.metadata && n.metadata.parserProvenance;
    return typeof provenance === 'string' && provenance.startsWith('tree-sitter:python');
  });
  return { pythonFileCount: pythonNodes.length, pythonTreeSitterActive };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message, category, requestId, options) {
  const diagnostic = sanitizeDiagnostic(new AdapterError(category, message, options));
  sendJson(res, status, { error: message, diagnostics: [diagnostic], requestId });
}

// GitHub's own rate-limit responses (403, occasionally 429) surface through
// GithubFetchError as plain text ("API rate limit exceeded for ...") --
// there's no separate ErrorCategory for this in MOO-68's fixed set (rate
// limiting is a kind of github_access failure, not a ninth category), but
// callers still need to tell "this repository doesn't exist" apart from
// "come back later" -- retryable:true plus a 429 status is that signal.
export const RATE_LIMIT_PATTERN = /rate limit/i;

export class GraphAnalysisTimeoutError extends Error {}

export function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new GraphAnalysisTimeoutError(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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

/** @param {{config: object, cache: import('../lib/graph-cache.js').GraphCache}} deps */
export function createGraphRepositoryHandler({ config, cache }) {
  return async function handleGraphRepository(req, res, requestId) {
    const log = createRequestLogger(requestId);

    let body;
    try {
      body = await readJsonBody(req, config.maxRequestBodyBytes);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return sendJson(res, 413, { error: 'Request body too large' });
      }
      return sendJson(res, 400, { error: 'Request body must be valid JSON' });
    }

    let request;
    try {
      request = validateRepoRequest(body);
    } catch (err) {
      if (err instanceof ValidationError) {
        log.warn('rejected graph-repository request: invalid input', { message: err.message });
        return sendError(res, 400, err.message, 'unsupported_input', requestId);
      }
      throw err;
    }

    if (!isRepoAllowed(request.owner, request.repo, config)) {
      log.warn('rejected graph-repository request: repository not allowlisted', {
        owner: request.owner,
        repo: request.repo,
      });
      return sendError(res, 403, 'This repository is not on the allowlist', 'unsupported_input', requestId);
    }

    log.info('graph-repository request accepted', { owner: request.owner, repo: request.repo, ref: request.ref, pr: request.pr });

    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();

    // Phase 0: resolve the ref only -- one or two cheap GitHub calls, no
    // content fetched. This is what makes the cache worth having: the key
    // needs the resolved SHA, and resolving it costs a tiny fraction of the
    // tree+blob fetching and parsing that a cache hit gets to skip entirely.
    let refResult;
    try {
      refResult = await withTimeout(
        resolveGithubRef(request, config),
        config.graphAnalysisTimeoutMs,
        `Repository ref resolution did not complete within ${config.graphAnalysisTimeoutMs}ms`
      );
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      if (err instanceof GraphAnalysisTimeoutError) {
        log.warn('graph-repository ref resolution timed out', { owner: request.owner, repo: request.repo, durationMs });
        return sendError(res, 504, err.message, 'timeout', requestId);
      }
      if (err instanceof GithubFetchError) {
        const rateLimited = RATE_LIMIT_PATTERN.test(err.message);
        log.warn('github ref resolution failed', { message: err.message, rateLimited, durationMs });
        return sendError(res, rateLimited ? 429 : 502, err.message, 'github_access', requestId, { retryable: rateLimited });
      }
      log.error('graph-repository ref resolution failed', { message: err && err.message, durationMs });
      return sendError(res, 502, 'Repository analysis failed while resolving its revision', 'github_access', requestId);
    }

    let context;
    let cacheKey;
    try {
      context = buildRequestContext(request, refResult);
      cacheKey = buildCacheKey({
        context,
        analyzerName: ANALYZER.name,
        analyzerVersion: ANALYZER.version,
        graphSchemaVersion: GRAPH_IR_SCHEMA_VERSION,
        // MOO-72 Commit 1A: excludePatterns change what the graph actually
        // contains (which files are analyzed), so they must be part of the
        // key. normalizeExcludePatterns routes them through the analyzer's
        // own compileExcludePatterns (trim/split/dedupe) then lowercases and
        // sorts, so two requests differing only in formatting, order, or
        // case hash identically -- matching the case-insensitive matching
        // src/analyzer.js already performs.
        //
        // MOO-72 Commit 2: pythonTreeSitter is now the deployment-static,
        // actively-probed grammar capability (see node-tree-sitter-shim.js),
        // not a post-analysis derivation. It has to be knowable *before* the
        // analysis runs for the cache to be checkable at all, and probing it
        // at import time is both correct and cheap: the value and the cache
        // are recomputed together on every process restart. Omitted (not
        // false) when unavailable, preserving Commit 1A's key shape for the
        // capable case.
        options: {
          excludePatterns: normalizeExcludePatterns(request.excludePatterns),
          ...(PYTHON_TREE_SITTER_CAPABLE ? { pythonTreeSitter: true } : {}),
          ...cacheKeyRequestIdentity(context),
        },
      });
    } catch (err) {
      if (err instanceof AnalysisContextError) {
        log.warn('graph-repository contract violation', { message: err.message });
        return sendError(res, 502, 'The analyzed repository state could not be represented as a valid graph', 'malformed_analyzer_output', requestId);
      }
      log.error('graph-repository internal error', { message: err && err.message });
      return sendError(res, 500, 'Analysis failed', 'internal_error', requestId);
    }

    const cachedGraph = cache.get(cacheKey);
    if (cachedGraph) {
      const durationMs = Date.now() - startedAtMs;
      log.info('graph-repository cache hit', {
        owner: request.owner,
        repo: request.repo,
        resolvedSha: refResult.resolvedSha,
        durationMs,
        nodeCount: cachedGraph.nodes.length,
        edgeCount: cachedGraph.edges.length,
        cacheKey,
        cacheHit: true,
      });
      // Built fresh rather than stored/replayed, so timing reflects *this*
      // request and the stored graph is never mutated to carry per-request
      // response metadata. excludePatterns is rebuilt from *this* request
      // for the same reason: normalizeExcludePatterns collapses requests
      // differing only in case/order/whitespace onto one cache entry, so the
      // entry's own metadata.excludePatterns reflects whichever request
      // happened to populate it, not necessarily this one.
      const responseGraph = {
        ...cachedGraph,
        metadata: { ...cachedGraph.metadata, excludePatterns: displayExcludePatterns(request.excludePatterns) },
      };
      return sendJson(res, 200, buildAdapterResult({
        graph: responseGraph,
        warnings: responseGraph.warnings,
        provenance: { analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version },
        timing: { startedAt, durationMs },
        cache: { key: cacheKey, hit: true },
      }));
    }

    // Phase 1: fetch + parse (GitHub API calls, Parser.extract on each
    // file's content). Failures here are about the repository's own state
    // or content -- github_access, timeout, or parser_failure -- not a bug
    // in this endpoint's own glue code, so they're categorized and logged
    // distinctly from phase 2's failures below.
    let resolved;
    try {
      resolved = await withTimeout(
        fetchAndAnalyzeRepo(request, refResult, config),
        config.graphAnalysisTimeoutMs,
        `Repository analysis did not complete within ${config.graphAnalysisTimeoutMs}ms`
      );
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      if (err instanceof GraphAnalysisTimeoutError) {
        log.warn('graph-repository analysis timed out', { owner: request.owner, repo: request.repo, durationMs });
        return sendError(res, 504, err.message, 'timeout', requestId);
      }
      if (err instanceof GithubFetchError) {
        const rateLimited = RATE_LIMIT_PATTERN.test(err.message);
        log.warn('github fetch failed', { message: err.message, rateLimited, durationMs });
        return sendError(res, rateLimited ? 429 : 502, err.message, 'github_access', requestId, { retryable: rateLimited });
      }
      // Anything else escaping fetchAndAnalyzeRepo (Parser.extract,
      // buildAnalysisData) is a failure to parse this repository's actual
      // content, not an unsupported-input or internal-server condition.
      log.error('repository parsing failed', { message: err && err.message, durationMs });
      return sendError(res, 502, 'Repository analysis failed while parsing its content', 'parser_failure', requestId);
    }

    // Phase 2: build the GraphIR/AdapterResult from what phase 1 already
    // fetched -- no more network calls, so failures here really are this
    // endpoint's own contract/glue-code problems.
    try {
      const graph = adaptRepositoryAnalysis({ analysisData: resolved.result, context, analyzer: ANALYZER });
      const { pythonFileCount, pythonTreeSitterActive } = derivePythonParserCapability(graph);
      // Warning only -- the cache key's own pythonTreeSitter component now
      // comes from the startup grammar probe (see the key built above),
      // since it has to be knowable before the analysis runs. This stays
      // the accurate per-analysis signal for what the user is told.
      if (pythonFileCount > 0 && !pythonTreeSitterActive) {
        graph.warnings.push(
          'Python call-graph analysis degraded: tree-sitter runtime unavailable, falling back to heuristic regex parsing.'
        );
      }
      // Stored after the warning is appended, so a cache hit serves the same
      // warnings a miss did. Tree-sitter degradation is process-permanent
      // (the grammar either loaded at startup or it didn't) and is already
      // part of the key, so unlike the file layer's transient pyan3
      // failures there is nothing here worth refusing to cache.
      cache.set(cacheKey, graph);
      const durationMs = Date.now() - startedAtMs;
      const adapterResult = buildAdapterResult({
        graph,
        warnings: graph.warnings,
        provenance: { analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version },
        timing: { startedAt, durationMs },
        cache: { key: cacheKey, hit: false },
      });
      // Sufficient to identify where an analysis run went, without ever
      // logging source content or the GitHub token: request ID (via
      // createRequestLogger), repository/revision identity, duration,
      // node/edge counts, cache status, and warning count.
      log.info('graph-repository analysis complete', {
        owner: request.owner,
        repo: request.repo,
        sourceOwner: resolved.sourceOwner,
        sourceRepo: resolved.sourceRepo,
        resolvedSha: resolved.resolvedSha,
        durationMs,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        warningCount: graph.warnings.length,
        cacheKey,
        cacheHit: false,
      });
      sendJson(res, 200, adapterResult);
    } catch (err) {
      if (err instanceof AnalysisContextError || err instanceof AdapterResultError) {
        log.warn('graph-repository contract violation', { message: err.message });
        return sendError(res, 502, 'The analyzed repository state could not be represented as a valid graph', 'malformed_analyzer_output', requestId);
      }
      log.error('graph-repository internal error', { message: err && err.message });
      sendError(res, 500, 'Analysis failed', 'internal_error', requestId);
    }
  };
}
