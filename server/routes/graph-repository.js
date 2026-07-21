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
import { analyzeGithubRepo, GithubFetchError } from '../lib/github-analyzer-bridge.js';
import { createRequestLogger } from '../lib/logger.js';
import { readJsonBody, BodyTooLargeError } from '../lib/http-body.js';
import { adaptRepositoryAnalysis } from '../../src/adapters/repositoryGraphAdapter.js';
import { normalizeContext, AnalysisContextError } from '../../src/graph-ir/githubContext.js';
import { GRAPH_IR_SCHEMA_VERSION } from '../../src/graph-ir/graphIR.js';
import { AdapterError, buildAdapterResult, AdapterResultError, sanitizeDiagnostic } from '../../src/graph-ir/adapterResult.js';
import { buildCacheKey } from '../../src/graph-ir/cacheKey.js';

const ANALYZER = { name: 'codeflow-repository-adapter', version: '1.0.0' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message, category, requestId) {
  const diagnostic = sanitizeDiagnostic(new AdapterError(category, message));
  sendJson(res, status, { error: message, diagnostics: [diagnostic], requestId });
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

/** @param {{config: object}} deps */
export function createGraphRepositoryHandler({ config }) {
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
    try {
      const resolved = await analyzeGithubRepo(request, config);
      const context = buildRequestContext(request, resolved);
      const graph = adaptRepositoryAnalysis({ analysisData: resolved.result, context, analyzer: ANALYZER });
      const cacheKey = buildCacheKey({
        context,
        analyzerName: ANALYZER.name,
        analyzerVersion: ANALYZER.version,
        graphSchemaVersion: GRAPH_IR_SCHEMA_VERSION,
      });
      const adapterResult = buildAdapterResult({
        graph,
        warnings: graph.warnings,
        provenance: { analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version },
        timing: { startedAt, durationMs: Date.now() - Date.parse(startedAt) },
        // No durable cache store exists yet -- centralized caching is
        // MOO-72's job (see docs/graph-ir-contract.md's ownership rules).
        // This endpoint reports the key an eventual cache would use, always
        // as a miss.
        cache: { key: cacheKey, hit: false },
      });
      log.info('graph-repository analysis complete', {
        sourceOwner: resolved.sourceOwner,
        sourceRepo: resolved.sourceRepo,
        resolvedSha: resolved.resolvedSha,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        warningCount: graph.warnings.length,
      });
      sendJson(res, 200, adapterResult);
    } catch (err) {
      if (err instanceof GithubFetchError) {
        log.warn('github fetch failed', { message: err.message });
        return sendError(res, 502, err.message, 'github_access', requestId);
      }
      if (err instanceof AnalysisContextError || err instanceof AdapterResultError) {
        log.warn('graph-repository contract violation', { message: err.message });
        return sendError(res, 502, 'The analyzed repository state could not be represented as a valid graph', 'malformed_analyzer_output', requestId);
      }
      log.error('graph-repository analysis failed', { message: err && err.message });
      sendError(res, 500, 'Analysis failed', 'internal_error', requestId);
    }
  };
}
