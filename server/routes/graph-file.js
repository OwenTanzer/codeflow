// POST /api/graph/file — MOO-70 Commit 7.
//
// The file-layer counterpart to server/routes/graph-repository.js: same
// phase1 (network/subprocess, categorized failures) / phase2 (pure glue,
// AdapterResult) structure, reusing that file's buildRequestContext/
// withTimeout/GraphAnalysisTimeoutError/RATE_LIMIT_PATTERN directly rather
// than duplicating them. Fetches only the requested file/package's blobs
// (never the whole repository, unlike analyzeGithubRepo) via
// github-analyzer-bridge.js's resolveRef/resolveCommitSha/
// resolvePathEntry/fetchSubtreeFiles/fetchAllContents -- resolvePathEntry
// walks non-recursively to the requested path itself rather than ever
// fetching a (possibly GitHub-truncated, for a huge monorepo) full
// recursive repository tree.
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
import {
  configureGithubClient,
  resolveRef,
  resolveCommitSha,
  resolvePathEntry,
  fetchSubtreeFiles,
  fetchAllContents,
  GithubFetchError,
} from '../lib/github-analyzer-bridge.js';
import { buildRequestContext, withTimeout, GraphAnalysisTimeoutError, RATE_LIMIT_PATTERN, cacheKeyRequestIdentity } from './graph-repository.js';
import { stagePythonFiles, runPyan3 } from '../lib/pyan3Adapter.js';
import { parseDotGraph, extractPyanNodes, extractPyanEdges } from '../lib/dotGraph.js';
import { indexPythonSymbols } from '../lib/pythonSymbolIndex.js';
import { joinPyanToSymbols } from '../lib/pyanSymbolJoin.js';
import { adaptFileAnalysis } from '../../src/adapters/fileGraphAdapter.js';
import { chooseDepthMode } from '../../src/graph-ir/depthPolicy.js';
import { buildCacheKey } from '../../src/graph-ir/cacheKey.js';
import { GRAPH_IR_SCHEMA_VERSION } from '../../src/graph-ir/graphIR.js';
import { AdapterError, buildAdapterResult, AdapterResultError, sanitizeDiagnostic } from '../../src/graph-ir/adapterResult.js';
import { AnalysisContextError, assertContextPropagation } from '../../src/graph-ir/githubContext.js';
import { makeCoordinate, normalizePath } from '../../src/graph-ir/sourceCoordinate.js';
import { createRequestAbortSignal, throwIfCancelled, RequestCancelledError } from '../lib/cancellation.js';
import { isValidSessionId } from '../lib/session-id.js';
import { relative } from 'node:path';
import { randomUUID } from 'node:crypto';

const ANALYZER = { name: 'codeflow-pyan3-adapter', version: '1.0.0' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message, category, requestId, options = {}) {
  const diagnostic = sanitizeDiagnostic(new AdapterError(category, message, options));
  sendJson(res, status, { error: message, diagnostics: [diagnostic], requestId, sessionId: options.sessionId ?? null });
}

/**
 * Run pyan3 for a staged request and never throw — MOO-70 Commit 9
 * resilience requirement ("keep [analysis] operational when pyan3
 * fails"). A pyan3 crash (any category: subprocess_failure,
 * parser_failure, timeout) degrades to an empty relationship set (the
 * request still completes with a tree-sitter-only, lower-confidence
 * graph — Commit 5's `symbolOnly` path) rather than failing the whole
 * request. Extracted from the handler and exported specifically so this
 * behavior is unit-testable without a real GitHub fetch — running pyan3
 * itself needs no network, only already-staged local files.
 * @param {object} input
 * @param {string} input.pythonBin
 * @param {{dir: string}} input.workspace
 * @param {string[]} input.absolutePaths
 * @param {number} input.timeoutMs
 * @param {AbortSignal} [input.signal] - MOO-72 Commit 4: threaded straight into execFile; undefined is a no-op
 * @returns {Promise<{pyanNodes: object[], pyanEdges: object[], warnings: string[], failedCategory: string|null}>}
 */
export async function runPyan3ForFile({ pythonBin, workspace, absolutePaths, timeoutMs, signal }) {
  try {
    const pyanResult = await runPyan3({ pythonBin, workspace, absolutePaths, timeoutMs, signal });
    const digraph = parseDotGraph(pyanResult.dot);
    return {
      pyanNodes: extractPyanNodes(digraph),
      pyanEdges: extractPyanEdges(digraph),
      warnings: [],
      failedCategory: null,
    };
  } catch (err) {
    const category = err instanceof AdapterError ? err.category : 'subprocess_failure';
    return {
      pyanNodes: [],
      pyanEdges: [],
      warnings: [`pyan3 analysis failed (${category}): ${err.message}`],
      failedCategory: category,
    };
  }
}

/**
 * Run pyan3 for a set of already-fetched files as one shared operation
 * usable by every concurrent caller requesting the same file/package@revision
 * — MOO-72 Commit 4's InFlightRegistry factory. Unlike runPyan3ForFile
 * (which takes a caller-owned workspace), this function owns the *entire*
 * workspace-dependent phase itself: it creates its own workspace (keyed by
 * a fresh id independent of any caller's requestId, since concurrent
 * callers share this one operation), stages `files`, runs pyan3, and tears
 * the workspace down in a `finally` that only runs once the shared
 * operation itself settles — never gated on any individual caller's
 * request lifecycle. `files` is safe to reuse across every co-arriving
 * caller because they only ever share an in-flight slot when their
 * resolved file contents are identical by construction (they share a
 * cache key).
 *
 * The returned pyanNodes are converted from workspace-absolute to
 * repository-relative paths before this function returns, specifically so
 * every waiter can join them against its own symbolEntries with
 * `joinPyanToSymbols({..., workspaceDir: undefined})` — none of them has
 * (or should need) access to a workspace that may already be torn down by
 * the time they receive this result.
 * @param {object} input
 * @param {string} input.pythonBin
 * @param {import('../lib/workspace.js').WorkspaceManager} input.workspaceManager
 * @param {{path: string, content: string}[]} input.files
 * @param {number} input.timeoutMs
 * @param {AbortSignal} input.internalSignal - the InFlightRegistry's own controller signal, fires only once every waiter has detached
 * @returns {Promise<{pyanNodes: object[], pyanEdges: object[], warnings: string[], failedCategory: string|null}>}
 */
export async function runSharedPyan3Analysis({ pythonBin, workspaceManager, files, timeoutMs, internalSignal }) {
  const workspace = await workspaceManager.createRequestWorkspace(randomUUID());
  try {
    const absolutePaths = await stagePythonFiles(workspace, files);
    const outcome = await runPyan3ForFile({ pythonBin, workspace, absolutePaths, timeoutMs, signal: internalSignal });
    const pyanNodes = outcome.pyanNodes.map((node) =>
      node.path ? { ...node, path: normalizePath(relative(workspace.dir, node.path)) } : node
    );
    return { ...outcome, pyanNodes };
  } finally {
    await workspace.cleanup();
  }
}

/**
 * Apply file-count/byte-size budgets to an already-selected target file
 * set (one file, or the members of one requested package) — never to the
 * whole repository tree. PR review finding: routing the file layer
 * through fetchTree() applied MAX_REPO_FILES/MAX_REPO_BYTES to *every*
 * analyzable file in the repository before the requested file/package was
 * even selected, so a tiny file in a large monorepo could be rejected for
 * reasons entirely unrelated to what was actually requested. Mirrors
 * `selectAnalyzableFiles`'s own skip-oversized-individually /
 * fail-on-aggregate-or-count semantics, scoped to just this request's
 * target set, and deliberately does not apply
 * shouldIgnoreDirectory/shouldExcludeFile — those are repository-wide
 * *view* policy (hiding vendor/build directories from the overall graph),
 * not a reason to refuse a file the caller explicitly asked to see.
 * @param {{path: string, size?: number}[]} targetFiles
 * @param {{maxRepoFiles: number, maxFileBytes: number, maxRepoBytes: number}} limits
 * @returns {{path: string, size?: number}[]}
 * @throws {ValidationError}
 */
export function enforceFileRequestLimits(targetFiles, { maxRepoFiles, maxFileBytes, maxRepoBytes }) {
  const files = [];
  let totalBytes = 0;
  for (const file of targetFiles) {
    const size = typeof file.size === 'number' ? file.size : 0;
    if (size > maxFileBytes) continue; // skipped, same as selectAnalyzableFiles' per-file behavior
    totalBytes += size;
    if (totalBytes > maxRepoBytes) {
      throw new ValidationError(
        `The requested file/package exceeds the configured aggregate size limit of ${maxRepoBytes} bytes ` +
          `(reached ${totalBytes} bytes and counting). Raise MAX_REPO_BYTES if this is expected.`
      );
    }
    files.push(file);
  }
  if (files.length > maxRepoFiles) {
    throw new ValidationError(
      `The requested package has ${files.length} analyzable files, over the configured limit of ${maxRepoFiles}. ` +
        'Raise MAX_REPO_FILES if this is expected.'
    );
  }
  return files;
}

/**
 * If the client declared what revision it expected (from its own
 * already-loaded parent graph's AnalysisContext), verify the freshly
 * resolved revision still matches before doing any real work. PR review
 * finding: a PR-mode request always re-resolves the PR's *current* head
 * (resolveRef ignores any `ref` once `pr` is set) — without this check, a
 * PR receiving a new commit between the repository graph loading and a
 * file drill-down would silently analyze a different revision than the
 * one the user is looking at, exactly what MOO-70's revision-pinning
 * requirement exists to prevent. Reuses
 * src/graph-ir/githubContext.js's assertContextPropagation (the same
 * mechanism MOO-68 built for this exact class of check) rather than a
 * new ad hoc comparison.
 * @param {object} request - the validated file request (validateFileRequest's output)
 * @param {{sourceOwner: string, sourceRepo: string, resolvedSha: string}} resolved - what was actually just resolved
 * @throws {AnalysisContextError}
 */
export function assertRevisionStillExpected(request, resolved) {
  if (!request.expectedResolvedSha) return;
  const expected = {
    owner: request.owner,
    repo: request.repo,
    sourceOwner: request.expectedSourceOwner || request.owner,
    sourceRepo: request.expectedSourceRepo || request.repo,
    resolvedSha: request.expectedResolvedSha,
  };
  const actual = {
    owner: request.owner,
    repo: request.repo,
    sourceOwner: resolved.sourceOwner,
    sourceRepo: resolved.sourceRepo,
    resolvedSha: resolved.resolvedSha,
  };
  assertContextPropagation(expected, actual);
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

/** @param {{config: object, workspaceManager: import('../lib/workspace.js').WorkspaceManager, cache: import('../lib/graph-cache.js').GraphCache, metrics: import('../lib/metrics.js').Metrics, inflightRegistry: import('../lib/inflight-registry.js').InFlightRegistry}} deps */
export function createGraphFileHandler({ config, workspaceManager, cache, metrics, inflightRegistry }) {
  return async function handleGraphFile(req, res, requestId) {
    let log = createRequestLogger(requestId, { layer: 'file' });

    // Declared before any rejection branch so every terminal outcome --
    // including the earliest ones -- can report a real durationMs and
    // record a metric.
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();

    // MOO-72 Commit 1B: see cancellation.js's own doc comment for why this
    // watches `res`, not `req`, for a disconnect.
    const { signal, cleanup } = createRequestAbortSignal(req, res);

    let body;
    try {
      body = await readJsonBody(req, config.maxRequestBodyBytes);
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      // PR review finding: a client disconnecting while the body is still
      // being read must not be misclassified as validation_error -- see
      // the matching comment in graph-repository.js.
      if (signal.aborted) {
        log.info('graph-file request cancelled (client disconnected)', { durationMs, resultState: 'cancelled' });
        metrics.record({ layer: 'file', resultState: 'cancelled', durationMs });
        cleanup();
        return;
      }
      metrics.record({ layer: 'file', resultState: 'validation_error', durationMs });
      cleanup();
      if (err instanceof BodyTooLargeError) {
        log.warn('rejected graph-file request: body too large', { durationMs, resultState: 'validation_error' });
        return sendJson(res, 413, { error: 'Request body too large', requestId, sessionId: null });
      }
      log.warn('rejected graph-file request: body not valid JSON', { durationMs, resultState: 'validation_error' });
      return sendJson(res, 400, { error: 'Request body must be valid JSON', requestId, sessionId: null });
    }

    // sessionId can only be known once the body has been parsed -- see the
    // matching comment in graph-repository.js for why this is checked
    // against the raw body, not a (possibly never-constructed) validated
    // request object.
    const rawSessionId = isValidSessionId(body && body.sessionId) ? body.sessionId : null;

    let request;
    try {
      request = validateFileRequest(body);
    } catch (err) {
      if (err instanceof ValidationError) {
        const durationMs = Date.now() - startedAtMs;
        log.warn('rejected graph-file request: invalid input', { errorMessage: err.message, durationMs, resultState: 'validation_error' });
        metrics.record({ layer: 'file', resultState: 'validation_error', durationMs });
        cleanup();
        return sendError(res, 400, err.message, 'unsupported_input', requestId, { sessionId: rawSessionId });
      }
      cleanup();
      throw err;
    }

    log = createRequestLogger(requestId, { layer: 'file', sessionId: request.sessionId });

    if (!isRepoAllowed(request.owner, request.repo, config)) {
      const durationMs = Date.now() - startedAtMs;
      log.warn('rejected graph-file request: repository not allowlisted', { owner: request.owner, repo: request.repo, durationMs, resultState: 'not_allowlisted' });
      metrics.record({ layer: 'file', resultState: 'not_allowlisted', durationMs });
      cleanup();
      return sendError(res, 403, 'This repository is not on the allowlist', 'unsupported_input', requestId, { sessionId: request.sessionId });
    }

    log.info('graph-file request accepted', {
      owner: request.owner,
      repo: request.repo,
      ref: request.ref,
      pr: request.pr,
      path: request.path,
    });

    try {
      // Phase 1: fetch (GitHub API calls, scoped to just the requested
      // file/package's blobs -- never the whole repository).
      let resolved;
      try {
        resolved = await withTimeout(
          (async () => {
            // PR review finding: resolveRef/resolveCommitSha/etc. use the
            // shared GitHub client, whose token is otherwise only ever set
            // by analyzeGithubRepo() (the repository layer's entry point,
            // never called here) -- without this, every GitHub call this
            // route makes would run unauthenticated regardless of
            // config.githubToken, unless some unrelated request happened
            // to set it first as a side effect.
            configureGithubClient({ token: config.githubToken });

            const { owner, repo, ref: resolvedRef } = await resolveRef(request);
            const resolvedSha = request.pr != null ? resolvedRef : await resolveCommitSha(owner, repo, resolvedRef);

            // Fail fast if a PR moved since the parent graph was loaded,
            // before doing any of the real (wasted, if stale) work below.
            assertRevisionStillExpected(request, { sourceOwner: owner, sourceRepo: repo, resolvedSha });

            // Walk to the requested path's own entry non-recursively
            // (never the whole repository tree, which can be truncated by
            // GitHub for a large enough monorepo) to determine file vs.
            // package mode, then fetch only that scope's contents.
            const entry = await resolvePathEntry({ owner, repo, resolvedRef, path: request.path });
            if (!entry) {
              throw new ValidationError(`"${request.path}" was not found in this revision`);
            }
            let treeFiles;
            if (entry.type === 'blob') {
              treeFiles = [entry];
            } else if (entry.type === 'tree') {
              const subtreeEntries = await fetchSubtreeFiles({ owner, repo, sha: entry.sha, pathPrefix: entry.path });
              treeFiles = subtreeEntries.filter((e) => e.type === 'blob');
            } else {
              throw new ValidationError(`"${request.path}" is not a file or directory`);
            }

            const target = resolveFileTarget({ treeFiles, requestedPath: request.path });
            const limitedFiles = enforceFileRequestLimits(target.targetFiles, {
              maxRepoFiles: config.maxRepoFiles,
              maxFileBytes: config.maxFileBytes,
              maxRepoBytes: config.maxRepoBytes,
            });
            if (limitedFiles.length === 0) {
              throw new ValidationError(`"${request.path}" has no files remaining after applying size limits`);
            }
            const contents = await fetchAllContents(owner, repo, limitedFiles);
            return {
              sourceOwner: owner,
              sourceRepo: repo,
              resolvedSha,
              mode: target.mode,
              files: limitedFiles.map((f, i) => ({ path: f.path, content: contents[i] || '' })),
            };
          })(),
          {
            timeoutMs: config.graphAnalysisTimeoutMs,
            signal,
            timeoutMessage: `File analysis did not complete within ${config.graphAnalysisTimeoutMs}ms`,
          }
        );
      } catch (err) {
        const durationMs = Date.now() - startedAtMs;
        if (err instanceof RequestCancelledError) {
          log.info('graph-file request cancelled (client disconnected)', { durationMs, resultState: 'cancelled' });
          metrics.record({ layer: 'file', resultState: 'cancelled', durationMs });
          return;
        }
        if (err instanceof GraphAnalysisTimeoutError) {
          log.warn('graph-file analysis timed out', { path: request.path, durationMs, resultState: 'timeout' });
          metrics.record({ layer: 'file', resultState: 'timeout', durationMs });
          return sendError(res, 504, err.message, 'timeout', requestId, { sessionId: request.sessionId });
        }
        if (err instanceof ValidationError) {
          log.warn('rejected graph-file request: path resolution failed', { errorMessage: err.message, durationMs, resultState: 'validation_error' });
          metrics.record({ layer: 'file', resultState: 'validation_error', durationMs });
          return sendError(res, 400, err.message, 'unsupported_input', requestId, { sessionId: request.sessionId });
        }
        if (err instanceof AnalysisContextError) {
          log.warn('rejected graph-file request: PR revision changed since the parent graph was loaded', { errorMessage: err.message, durationMs, resultState: 'validation_error' });
          metrics.record({ layer: 'file', resultState: 'validation_error', durationMs });
          return sendError(
            res,
            409,
            'The pull request has changed since the repository graph was loaded. Refresh the repository graph and try again.',
            'unsupported_input',
            requestId,
            { sessionId: request.sessionId }
          );
        }
        if (err instanceof GithubFetchError) {
          const rateLimited = RATE_LIMIT_PATTERN.test(err.message);
          log.warn('github fetch failed', { errorMessage: err.message, rateLimited, durationMs, resultState: 'github_error' });
          metrics.record({ layer: 'file', resultState: 'github_error', durationMs });
          return sendError(res, rateLimited ? 429 : 502, err.message, 'github_access', requestId, { retryable: rateLimited, sessionId: request.sessionId });
        }
        log.error('file source retrieval failed', { errorMessage: err && err.message, durationMs, resultState: 'internal_error' });
        metrics.record({ layer: 'file', resultState: 'internal_error', durationMs });
        return sendError(res, 502, 'File analysis failed while retrieving its source', 'github_access', requestId, { sessionId: request.sessionId });
      }

      // MOO-72 Commit 2: cache lookup sits here -- after the (comparatively
      // cheap) GitHub fetch that resolves the SHA and the file/package
      // target, but before the workspace staging and pyan3 subprocess that
      // actually dominate this route's cost.
      //
      // depthMode, not the post-analysis `chosen.mode`: chooseDepthMode
      // needs a built graph to pick an automatic depth, which is precisely
      // the work a cache hit must skip. `request.depth ?? 'auto'` is
      // request-derived, so lookup and storage always agree -- two
      // auto-depth requests for the same file@SHA share an entry (auto
      // depth is deterministic given the same graph), while an explicit
      // depth override gets its own.
      let cacheKey;
      let cacheContext;
      try {
        cacheContext = buildRequestContext(request, resolved);
        cacheKey = buildCacheKey({
          context: cacheContext,
          analyzerName: ANALYZER.name,
          analyzerVersion: ANALYZER.version,
          graphSchemaVersion: GRAPH_IR_SCHEMA_VERSION,
          // Matches fileGraphAdapter.js's own requestCoordinate() exactly,
          // so the key built here and the graph's eventual rootCoordinate
          // describe the same thing.
          coordinate: makeCoordinate({
            repository: { host: 'github.com', owner: cacheContext.sourceOwner, name: cacheContext.sourceRepo },
            revision: cacheContext.resolvedSha,
            path: request.path,
            symbolKind: 'module',
          }),
          options: {
            depthMode: request.depth != null ? request.depth : 'auto',
            ...cacheKeyRequestIdentity(cacheContext),
          },
        });
      } catch (err) {
        const durationMs = Date.now() - startedAtMs;
        if (err instanceof AnalysisContextError) {
          log.warn('graph-file contract violation while building the cache key', { errorMessage: err.message, durationMs, resultState: 'contract_violation' });
          metrics.record({ layer: 'file', resultState: 'contract_violation', durationMs });
          return sendError(res, 502, 'The analyzed file state could not be represented as a valid graph', 'malformed_analyzer_output', requestId, { sessionId: request.sessionId });
        }
        throw err;
      }

      throwIfCancelled(signal);

      const cachedGraph = cache.get(cacheKey);
      if (cachedGraph) {
        const durationMs = Date.now() - startedAtMs;
        // Unlike the repository layer, a file-layer cache entry is never
        // degraded: cache.set() below only stores a graph when
        // pyanOutcome.failedCategory is null, precisely so a transient
        // pyan3 failure can never get baked into an hour-long cached
        // partial result. So every hit here is a real 'success', not
        // something that needs re-deriving from the cached graph.
        log.info('graph-file cache hit', {
          owner: request.owner,
          repo: request.repo,
          path: request.path,
          resolvedSha: resolved.resolvedSha,
          durationMs,
          nodeCount: cachedGraph.nodes.length,
          edgeCount: cachedGraph.edges.length,
          cacheKey,
          resultState: 'success',
          cacheStatus: 'hit',
        });
        metrics.record({ layer: 'file', resultState: 'success', durationMs, cacheStatus: 'hit' });
        return sendJson(res, 200, buildAdapterResult({
          graph: cachedGraph,
          warnings: cachedGraph.warnings,
          provenance: { analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version },
          timing: { startedAt, durationMs },
          cache: { key: cacheKey, hit: true },
          requestId,
          sessionId: request.sessionId,
        }));
      }

      // MOO-72 Commit 4: pyan3 runs as one shared operation per cacheKey --
      // a second concurrent request for the same file/package@revision
      // joins this one instead of staging its own workspace and running
      // its own subprocess. The registry itself owns per-caller abort
      // handling (this caller's own `signal` detaches it without affecting
      // other waiters; the underlying subprocess is only cancelled once
      // every waiter has left), so no separate raceWithAbort wrapping is
      // needed here the way the old per-request call required.
      //
      // pyan3 failing does not fail the request -- degrade to a
      // tree-sitter-only graph (Commit 5's symbolOnly path) rather than a
      // 5xx, matching the resilience Commit 2's plan flagged needing. This
      // failure is isolated to this one request/response: it shares no
      // mutable state with server/routes/graph-repository.js's handler
      // (a separate closure over the same read-only `config`), so it
      // cannot affect the repository layer's own operation.
      //
      // Nonterminal event -- this request has not finished yet (joining,
      // GraphIR construction, and the terminal completion log below still
      // happen after it), so no resultState/metrics.record here. The one
      // terminal outcome (success or partial_success) is recorded once,
      // at the completion log, with the real joined.stats -- not
      // fabricated placeholder counts at this earlier point.
      const inflightBefore = inflightRegistry.has(cacheKey);
      const pyanOutcome = await inflightRegistry.subscribe(
        cacheKey,
        (internalSignal) =>
          runSharedPyan3Analysis({
            pythonBin: config.pythonBin,
            workspaceManager,
            files: resolved.files,
            timeoutMs: config.pyan3TimeoutMs,
            internalSignal,
          }),
        signal
      );
      const inflightStatus = inflightBefore ? 'coalesced' : 'executed';
      if (pyanOutcome.failedCategory) {
        log.warn('pyan3 analysis degraded; falling back to tree-sitter-only graph', {
          component: 'pyan3',
          componentState: 'degraded',
          failureCategory: pyanOutcome.failedCategory,
          path: request.path,
        });
      }

      // Phase 2: pure glue, no more network/subprocess calls. Diagnosed as
      // its own stage ("graph construction") -- covers symbol indexing,
      // joining, GraphIR conversion, and depth selection -- distinct from
      // source retrieval/workspace prep/pyan3 above.
      let chosen;
      let joined;
      try {
        const symbolEntries = [];
        for (const file of resolved.files) {
          const indexed = await indexPythonSymbols({ path: file.path, content: file.content });
          symbolEntries.push(...indexed.entries);
        }

        // MOO-72 Commit 4: no workspaceDir -- runSharedPyan3Analysis already
        // converted pyanOutcome.pyanNodes' paths to repository-relative
        // before its own (possibly shared, possibly already torn down)
        // workspace went away.
        joined = joinPyanToSymbols({ pyanNodes: pyanOutcome.pyanNodes, pyanEdges: pyanOutcome.pyanEdges, symbolEntries });
        joined.stats.warnings.push(...pyanOutcome.warnings);
        const fullGraph = adaptFileAnalysis({ context: cacheContext, requestPath: request.path, joined, analyzer: ANALYZER });

        chosen = chooseDepthMode({
          graph: fullGraph,
          requestKind: resolved.mode,
          totalSymbolCount: symbolEntries.length,
          override: request.depth || undefined,
        });
      } catch (err) {
        const durationMs = Date.now() - startedAtMs;
        if (err instanceof AnalysisContextError) {
          log.warn('graph-file contract violation during graph construction', { errorMessage: err.message, durationMs, resultState: 'contract_violation' });
          metrics.record({ layer: 'file', resultState: 'contract_violation', durationMs });
          return sendError(res, 502, 'The analyzed file state could not be represented as a valid graph', 'malformed_analyzer_output', requestId, { sessionId: request.sessionId });
        }
        log.error('graph construction failed (symbol indexing, join, or GraphIR conversion)', { errorMessage: err && err.message, durationMs, resultState: 'internal_error' });
        metrics.record({ layer: 'file', resultState: 'internal_error', durationMs });
        return sendError(res, 500, 'Analysis failed while building the file graph', 'internal_error', requestId, { sessionId: request.sessionId });
      }

      throwIfCancelled(signal); // checkpoint: don't cache or respond into a torn-down connection

      // Never cache a degraded result: a pyan3 failure is typically
      // transient (a subprocess timeout under load, a temporarily broken
      // install), and storing the tree-sitter-only fallback would keep
      // serving it for the full TTL long after pyan3 recovered. A miss that
      // re-runs pyan3 is cheap compared to silently degrading every
      // subsequent request for an hour.
      if (pyanOutcome.failedCategory === null) {
        cache.set(cacheKey, chosen.graph);
      }

      const durationMs = Date.now() - startedAtMs;
      const adapterResult = buildAdapterResult({
        graph: chosen.graph,
        warnings: chosen.graph.warnings,
        provenance: { analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version },
        timing: { startedAt, durationMs },
        cache: { key: cacheKey, hit: false },
        requestId,
        sessionId: request.sessionId,
      });

      const resultState = pyanOutcome.failedCategory ? 'partial_success' : 'success';
      log.info('graph-file analysis complete', {
        owner: request.owner,
        repo: request.repo,
        path: request.path,
        sourceOwner: resolved.sourceOwner,
        sourceRepo: resolved.sourceRepo,
        resolvedSha: resolved.resolvedSha,
        mode: resolved.mode,
        analyzerName: ANALYZER.name,
        analyzerVersion: ANALYZER.version,
        depth: chosen.mode,
        durationMs,
        nodeCount: chosen.graph.nodes.length,
        edgeCount: chosen.graph.edges.length,
        warningCount: chosen.graph.warnings.length,
        matchedCount: joined.stats.matchedCount,
        unresolvedCount: joined.stats.unresolvedCount,
        ambiguousCount: joined.stats.ambiguousCount,
        symbolOnlyCount: joined.stats.symbolOnlyCount,
        pyanFailedCategory: pyanOutcome.failedCategory,
        resultState,
        cacheKey,
        cacheStatus: 'miss',
        // MOO-72 Commit 4: distinct from cacheStatus (GraphCache) --
        // 'coalesced' means this request's pyan3 work was shared with an
        // already-running request for the same cacheKey rather than
        // starting its own subprocess. This request still records exactly
        // one terminal resultState of its own either way.
        inflightStatus,
      });
      metrics.record({ layer: 'file', resultState, durationMs, cacheStatus: 'miss' });
      sendJson(res, 200, adapterResult);
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      if (err instanceof RequestCancelledError) {
        log.info('graph-file request cancelled (client disconnected)', { durationMs, resultState: 'cancelled' });
        metrics.record({ layer: 'file', resultState: 'cancelled', durationMs });
        return;
      }
      if (err instanceof AnalysisContextError || err instanceof AdapterResultError) {
        log.warn('graph-file contract violation', { errorMessage: err.message, durationMs, resultState: 'contract_violation' });
        metrics.record({ layer: 'file', resultState: 'contract_violation', durationMs });
        return sendError(res, 502, 'The analyzed file state could not be represented as a valid graph', 'malformed_analyzer_output', requestId, { sessionId: request.sessionId });
      }
      log.error('graph-file internal error', { errorMessage: err && err.message, durationMs, resultState: 'internal_error' });
      metrics.record({ layer: 'file', resultState: 'internal_error', durationMs });
      sendError(res, 500, 'Analysis failed', 'internal_error', requestId, { sessionId: request.sessionId });
    } finally {
      // MOO-72 Commit 4: no per-request workspace to clean up here anymore
      // -- runSharedPyan3Analysis owns its own shared workspace's full
      // lifecycle (created, staged, and torn down inside that function,
      // gated on the shared operation itself settling, not on any one
      // caller's request lifecycle).
      cleanup();
    }
  };
}
