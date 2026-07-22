// POST /api/graph/file — MOO-70 Commit 7.
//
// The file-layer counterpart to server/routes/graph-repository.js: same
// phase1 (network/subprocess, categorized failures) / phase2 (pure glue,
// AdapterResult) structure, reusing that file's buildRequestContext/
// withTimeout/GraphAnalysisTimeoutError/RATE_LIMIT_PATTERN directly rather
// than duplicating them. Fetches only the requested file/package's blobs
// (never the whole repository, unlike analyzeGithubRepo) via
// github-analyzer-bridge.js's now-exported resolveRef/resolveCommitSha/
// fetchTree/fetchAllContents.
//
// Revision-pinning convention: a drill-down client should pass the parent
// graph's exact resolvedSha as `ref`, not a branch name — validateRepoRequest's
// REF_PATTERN already accepts either form, and resolveCommitSha already
// resolves a SHA-shaped ref back to itself idempotently, so this pins the
// revision through the existing field with no new request shape.
import { readJsonBody, BodyTooLargeError } from '../lib/http-body.js';
import { isRepoAllowed } from '../lib/allowlist.js';
import { createRequestLogger } from '../lib/logger.js';
import { validateFileRequest } from '../lib/validate-file-request.js';
import { ValidationError } from '../lib/validate-repo-request.js';
import { resolveRef, resolveCommitSha, fetchTree, fetchAllContents, GithubFetchError } from '../lib/github-analyzer-bridge.js';
import { buildRequestContext, withTimeout, GraphAnalysisTimeoutError, RATE_LIMIT_PATTERN } from './graph-repository.js';
import { stagePythonFiles, runPyan3 } from '../lib/pyan3Adapter.js';
import { parseDotGraph, extractPyanNodes, extractPyanEdges } from '../lib/dotGraph.js';
import { indexPythonSymbols } from '../lib/pythonSymbolIndex.js';
import { joinPyanToSymbols } from '../lib/pyanSymbolJoin.js';
import { adaptFileAnalysis } from '../../src/adapters/fileGraphAdapter.js';
import { chooseDepthMode } from '../../src/graph-ir/depthPolicy.js';
import { buildCacheKey } from '../../src/graph-ir/cacheKey.js';
import { GRAPH_IR_SCHEMA_VERSION } from '../../src/graph-ir/graphIR.js';
import { AdapterError, buildAdapterResult, AdapterResultError, sanitizeDiagnostic } from '../../src/graph-ir/adapterResult.js';
import { AnalysisContextError } from '../../src/graph-ir/githubContext.js';

const ANALYZER = { name: 'codeflow-pyan3-adapter', version: '1.0.0' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message, category, requestId, options) {
  const diagnostic = sanitizeDiagnostic(new AdapterError(category, message, options));
  sendJson(res, status, { error: message, diagnostics: [diagnostic], requestId });
}

/**
 * Classify a requested path against the already-fetched tree: an exact
 * Python-file blob match is a 'file' request; one or more Python files
 * under `${path}/` is a 'package' request. Self-describing from the tree
 * rather than a client-supplied mode flag, so the client and server can
 * never disagree about what `path` actually is.
 * @param {object} input
 * @param {{path: string}[]} input.treeFiles
 * @param {string} input.requestedPath
 * @returns {{mode: 'file'|'package', targetFiles: object[]}}
 * @throws {ValidationError}
 */
export function resolveFileTarget({ treeFiles, requestedPath }) {
  const exact = treeFiles.find((f) => f.path === requestedPath);
  if (exact) {
    if (!exact.path.endsWith('.py')) {
      throw new ValidationError(`"${requestedPath}" is not a Python file — the file layer only supports .py files`);
    }
    return { mode: 'file', targetFiles: [exact] };
  }

  const prefix = requestedPath + '/';
  const packageFiles = treeFiles.filter((f) => f.path.startsWith(prefix) && f.path.endsWith('.py'));
  if (packageFiles.length > 0) {
    return { mode: 'package', targetFiles: packageFiles };
  }

  const anyUnderPrefix = treeFiles.some((f) => f.path.startsWith(prefix));
  if (anyUnderPrefix) {
    throw new ValidationError(`"${requestedPath}" contains no Python (.py) files — the file layer only supports Python`);
  }
  throw new ValidationError(`"${requestedPath}" was not found in this revision`);
}

/** @param {{config: object, workspaceManager: import('../lib/workspace.js').WorkspaceManager}} deps */
export function createGraphFileHandler({ config, workspaceManager }) {
  return async function handleGraphFile(req, res, requestId) {
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
      request = validateFileRequest(body);
    } catch (err) {
      if (err instanceof ValidationError) {
        log.warn('rejected graph-file request: invalid input', { message: err.message });
        return sendError(res, 400, err.message, 'unsupported_input', requestId);
      }
      throw err;
    }

    if (!isRepoAllowed(request.owner, request.repo, config)) {
      log.warn('rejected graph-file request: repository not allowlisted', { owner: request.owner, repo: request.repo });
      return sendError(res, 403, 'This repository is not on the allowlist', 'unsupported_input', requestId);
    }

    log.info('graph-file request accepted', {
      owner: request.owner,
      repo: request.repo,
      ref: request.ref,
      pr: request.pr,
      path: request.path,
    });

    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    let workspace = null;

    try {
      // Phase 1: fetch (GitHub API calls, scoped to just the requested
      // file/package's blobs -- never the whole repository).
      let resolved;
      try {
        resolved = await withTimeout(
          (async () => {
            const { owner, repo, ref: resolvedRef } = await resolveRef(request);
            const resolvedSha = request.pr != null ? resolvedRef : await resolveCommitSha(owner, repo, resolvedRef);
            const { files: treeFiles } = await fetchTree({
              owner,
              repo,
              resolvedRef,
              maxRepoFiles: config.maxRepoFiles,
              maxFileBytes: config.maxFileBytes,
              maxRepoBytes: config.maxRepoBytes,
            });
            const target = resolveFileTarget({ treeFiles, requestedPath: request.path });
            const contents = await fetchAllContents(owner, repo, target.targetFiles);
            return {
              sourceOwner: owner,
              sourceRepo: repo,
              resolvedSha,
              mode: target.mode,
              files: target.targetFiles.map((f, i) => ({ path: f.path, content: contents[i] || '' })),
            };
          })(),
          config.graphAnalysisTimeoutMs,
          `File analysis did not complete within ${config.graphAnalysisTimeoutMs}ms`
        );
      } catch (err) {
        const durationMs = Date.now() - startedAtMs;
        if (err instanceof GraphAnalysisTimeoutError) {
          log.warn('graph-file analysis timed out', { path: request.path, durationMs });
          return sendError(res, 504, err.message, 'timeout', requestId);
        }
        if (err instanceof ValidationError) {
          log.warn('rejected graph-file request: path resolution failed', { message: err.message });
          return sendError(res, 400, err.message, 'unsupported_input', requestId);
        }
        if (err instanceof GithubFetchError) {
          const rateLimited = RATE_LIMIT_PATTERN.test(err.message);
          log.warn('github fetch failed', { message: err.message, rateLimited, durationMs });
          return sendError(res, rateLimited ? 429 : 502, err.message, 'github_access', requestId, { retryable: rateLimited });
        }
        log.error('file source retrieval failed', { message: err && err.message, durationMs });
        return sendError(res, 502, 'File analysis failed while retrieving its source', 'github_access', requestId);
      }

      // Stage into a fresh request workspace -- always cleaned up below,
      // regardless of what happens next.
      workspace = await workspaceManager.createRequestWorkspace(requestId);
      const absolutePaths = await stagePythonFiles(workspace, resolved.files);

      // pyan3 failing does not fail the request -- degrade to a
      // tree-sitter-only graph (Commit 5's symbolOnly path) rather than a
      // 5xx, matching the resilience Commit 2's plan flagged needing.
      let pyanNodes = [];
      let pyanEdges = [];
      const pyanWarnings = [];
      try {
        const pyanResult = await runPyan3({
          pythonBin: config.pythonBin,
          workspace,
          absolutePaths,
          timeoutMs: config.pyan3TimeoutMs,
        });
        const digraph = parseDotGraph(pyanResult.dot);
        pyanNodes = extractPyanNodes(digraph);
        pyanEdges = extractPyanEdges(digraph);
      } catch (err) {
        const category = err instanceof AdapterError ? err.category : 'subprocess_failure';
        log.warn('pyan3 analysis failed; degrading to tree-sitter-only graph', { message: err.message, category });
        pyanWarnings.push(`pyan3 analysis failed (${category}): ${err.message}`);
      }

      // Phase 2: pure glue, no more network/subprocess calls.
      const symbolEntries = [];
      for (const file of resolved.files) {
        const indexed = await indexPythonSymbols({ path: file.path, content: file.content });
        symbolEntries.push(...indexed.entries);
      }

      const context = buildRequestContext(request, resolved);
      const joined = joinPyanToSymbols({ pyanNodes, pyanEdges, symbolEntries, workspaceDir: workspace.dir });
      joined.stats.warnings.push(...pyanWarnings);
      const fullGraph = adaptFileAnalysis({ context, requestPath: request.path, joined, analyzer: ANALYZER });

      const chosen = chooseDepthMode({
        graph: fullGraph,
        requestKind: resolved.mode,
        totalSymbolCount: symbolEntries.length,
        override: request.depth || undefined,
      });

      const cacheKey = buildCacheKey({
        context,
        analyzerName: ANALYZER.name,
        analyzerVersion: ANALYZER.version,
        graphSchemaVersion: GRAPH_IR_SCHEMA_VERSION,
        coordinate: chosen.graph.rootCoordinate,
        depth: chosen.mode,
      });

      const durationMs = Date.now() - startedAtMs;
      const adapterResult = buildAdapterResult({
        graph: chosen.graph,
        warnings: chosen.graph.warnings,
        provenance: { analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version },
        timing: { startedAt, durationMs },
        // No durable cache store exists yet -- centralized caching is
        // MOO-72's job. This endpoint reports the key an eventual cache
        // would use, always as a miss.
        cache: { key: cacheKey, hit: false },
      });

      log.info('graph-file analysis complete', {
        owner: request.owner,
        repo: request.repo,
        path: request.path,
        sourceOwner: resolved.sourceOwner,
        sourceRepo: resolved.sourceRepo,
        resolvedSha: resolved.resolvedSha,
        mode: resolved.mode,
        depth: chosen.mode,
        durationMs,
        nodeCount: chosen.graph.nodes.length,
        edgeCount: chosen.graph.edges.length,
        warningCount: chosen.graph.warnings.length,
        cacheKey,
        cacheHit: false,
      });
      sendJson(res, 200, adapterResult);
    } catch (err) {
      if (err instanceof AnalysisContextError || err instanceof AdapterResultError) {
        log.warn('graph-file contract violation', { message: err.message });
        return sendError(res, 502, 'The analyzed file state could not be represented as a valid graph', 'malformed_analyzer_output', requestId);
      }
      log.error('graph-file internal error', { message: err && err.message });
      sendError(res, 500, 'Analysis failed', 'internal_error', requestId);
    } finally {
      if (workspace) await workspace.cleanup();
    }
  };
}
