// POST /api/graph/function — MOO-71 Commits 5-6.
//
// The function-layer counterpart to server/routes/graph-file.js: same
// two-phase (network / pure glue) structure and the exact same
// revision-pinning convention (assertRevisionStillExpected, imported
// from graph-file.js rather than duplicated). Fetches only the one
// requested file's content -- a function always lives in exactly one
// file, so there's no file/package mode distinction here.
//
// MOO-71 Commit 6 update: now converts FlowchartIR into a real GraphIR
// (src/adapters/functionGraphAdapter.js) and returns it via
// buildAdapterResult, same as graph-file.js -- Commit 5 deliberately
// left this endpoint on a bespoke {flowchartIR, ...} envelope since
// converting to GraphIR was explicitly this ticket's own separate next
// commit; Commit 7 (rendering) needs a real GraphIR to consume, so this
// endpoint is where that conversion actually gets wired in.
//
// No pyan3-style degraded/partial mode: unlike the file layer (which can
// fall back to a tree-sitter-only graph when pyan3 fails), there is no
// fallback analyzer for the function layer. If @codevisualizer/core
// failed to initialize at startup, this route fails clearly before even
// attempting a GitHub fetch, rather than pretending to proceed.
import { readJsonBody, BodyTooLargeError } from '../lib/http-body.js';
import { isRepoAllowed } from '../lib/allowlist.js';
import { createRequestLogger } from '../lib/logger.js';
import { validateFunctionRequest } from '../lib/validate-function-request.js';
import { ValidationError } from '../lib/validate-repo-request.js';
import {
  configureGithubClient,
  resolveRef,
  resolveCommitSha,
  resolvePathEntry,
  fetchAllContents,
  GithubFetchError,
} from '../lib/github-analyzer-bridge.js';
import { buildRequestContext, withTimeout, GraphAnalysisTimeoutError, RATE_LIMIT_PATTERN, cacheKeyRequestIdentity } from './graph-repository.js';
import { assertRevisionStillExpected } from './graph-file.js';
import { indexPythonSymbols } from '../lib/pythonSymbolIndex.js';
import { lineColumnToCodeUnitOffset } from '../../src/graph-ir/codeUnitOffset.js';
import { analyzePythonFunction } from '@codevisualizer/core';
import { adaptFunctionAnalysis } from '../../src/adapters/functionGraphAdapter.js';
import { buildCacheKey } from '../../src/graph-ir/cacheKey.js';
import { GRAPH_IR_SCHEMA_VERSION } from '../../src/graph-ir/graphIR.js';
import { AdapterError, buildAdapterResult, AdapterResultError, sanitizeDiagnostic } from '../../src/graph-ir/adapterResult.js';
import { AnalysisContextError } from '../../src/graph-ir/githubContext.js';
import { makeCoordinate } from '../../src/graph-ir/sourceCoordinate.js';

const ANALYZER = { name: 'codeflow-codevisualizer-adapter', version: '1.0.0' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message, category, requestId, options) {
  const diagnostic = sanitizeDiagnostic(new AdapterError(category, message, options));
  sendJson(res, status, { error: message, diagnostics: [diagnostic], requestId });
}

/**
 * Find the single symbol entry whose symbolPath exactly matches the
 * request's — never a prefix/fuzzy match, and never falling back to a
 * name-only or position-based guess. Distinguishes three outcomes the
 * route needs to handle differently (the ticket's own "reject
 * unresolved or ambiguous coordinates rather than analyzing guessed
 * source" — a deliberate departure from MOO-70's pyan3-join, which
 * tie-breaks same-name duplicates instead of rejecting them).
 * @param {object[]} entries - indexPythonSymbols(...).entries
 * @param {string[]} symbolPath
 * @returns {{ outcome: 'matched', entry: object } | { outcome: 'unresolved' } | { outcome: 'ambiguous', count: number }}
 */
/**
 * Decide what a FunctionRangeNotFoundError actually means — MOO-71 Commit 10.
 *
 * @codevisualizer/core throws this one error for two genuinely different
 * situations, because tree-sitter is error-tolerant: it never throws on a
 * syntax error, it returns a tree containing ERROR nodes. Source that does not
 * parse therefore does not arrive as a distinct "parse error" — it arrives as
 * "no function definition matches that exact range", the same error a real
 * offset-conversion bug on our side would produce.
 *
 * Reporting both as an internal error (which is what this route did before)
 * told users we had a bug when their file simply wasn't valid Python, and made
 * the two indistinguishable in logs — the opposite of what Commit 10's
 * "logs identify parser failure separately" asks for.
 *
 * Deliberately target-local rather than file-wide: an early version checked
 * `tree.rootNode.hasError()` for the whole file, which meant an unrelated
 * syntax error anywhere in the file would label *every* function's
 * FunctionRangeNotFoundError as parser_failure -- including one whose own
 * range parses cleanly, concealing a genuine offset-conversion bug behind an
 * unrelated typo elsewhere in the file. `errorRanges` (from the symbol index,
 * which already walked the tree for `tree.rootNode.hasError()`) lets this
 * check only the target function's own [startByte, endByte) span.
 *
 * Extracted and exported so both branches are unit-testable without a live
 * GitHub credential, matching this module's existing `resolveFunctionSymbol`.
 *
 * @param {object} input
 * @param {{startIndex: number, endIndex: number}[]} input.errorRanges
 * @param {number} input.startByte
 * @param {number} input.endByte
 * @returns {{status: number, category: string, message: string}}
 */
export function classifyFunctionRangeFailure({ errorRanges, startByte, endByte }) {
  const targetRangeHasParseError = errorRanges.some(
    (range) => range.startIndex < endByte && range.endIndex > startByte
  );
  if (targetRangeHasParseError) {
    // The source is at fault. Same category pyan3's adapter already uses for
    // the same situation at the file layer (server/lib/pyan3Adapter.js), so
    // both analyzers report an unparseable file identically.
    return {
      status: 502,
      category: 'parser_failure',
      message: 'This file contains syntax errors, so its control flow could not be analyzed. Fix the parse errors and retry.',
    };
  }
  // The file parses cleanly and our offset conversion still disagrees with
  // CodeVisualizer's tree. That is our bug — named precisely rather than left
  // as a generic 500, so it is debuggable.
  return {
    status: 502,
    category: 'malformed_analyzer_output',
    message: `Internal conversion error: computed byte range [${startByte}, ${endByte}] does not match any function in CodeVisualizer's own parse.`,
  };
}

export function resolveFunctionSymbol(entries, symbolPath) {
  const matches = entries.filter(
    (entry) => Array.isArray(entry.symbolPath) &&
      entry.symbolPath.length === symbolPath.length &&
      entry.symbolPath.every((seg, i) => seg === symbolPath[i])
  );
  if (matches.length === 0) return { outcome: 'unresolved' };
  if (matches.length > 1) return { outcome: 'ambiguous', count: matches.length };
  return { outcome: 'matched', entry: matches[0] };
}

/** @param {{config: object, getCodeVisualizerAvailable: () => boolean, cache: import('../lib/graph-cache.js').GraphCache}} deps */
export function createGraphFunctionHandler({ config, getCodeVisualizerAvailable, cache }) {
  return async function handleGraphFunction(req, res, requestId) {
    const log = createRequestLogger(requestId);

    if (getCodeVisualizerAvailable && !getCodeVisualizerAvailable()) {
      log.warn('rejected graph-function request: CodeVisualizer core unavailable');
      return sendError(
        res,
        502,
        'Function analysis is currently unavailable (the CodeVisualizer core failed to initialize).',
        'subprocess_failure',
        requestId
      );
    }

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
      request = validateFunctionRequest(body);
    } catch (err) {
      if (err instanceof ValidationError) {
        log.warn('rejected graph-function request: invalid input', { message: err.message });
        return sendError(res, 400, err.message, 'unsupported_input', requestId);
      }
      throw err;
    }

    if (!isRepoAllowed(request.owner, request.repo, config)) {
      log.warn('rejected graph-function request: repository not allowlisted', { owner: request.owner, repo: request.repo });
      return sendError(res, 403, 'This repository is not on the allowlist', 'unsupported_input', requestId);
    }

    log.info('graph-function request accepted', {
      owner: request.owner,
      repo: request.repo,
      ref: request.ref,
      pr: request.pr,
      path: request.path,
      symbolPath: request.symbolPath,
    });

    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();

    try {
      let resolved;
      try {
        resolved = await withTimeout(
          (async () => {
            configureGithubClient({ token: config.githubToken });

            const { owner, repo, ref: resolvedRef } = await resolveRef(request);
            const resolvedSha = request.pr != null ? resolvedRef : await resolveCommitSha(owner, repo, resolvedRef);

            assertRevisionStillExpected(request, { sourceOwner: owner, sourceRepo: repo, resolvedSha });

            const entry = await resolvePathEntry({ owner, repo, resolvedRef, path: request.path });
            if (!entry) {
              throw new ValidationError(`"${request.path}" was not found in this revision`);
            }
            if (entry.type !== 'blob') {
              throw new ValidationError(`"${request.path}" is not a file — the function layer requires an exact file path`);
            }
            if (!entry.path.endsWith('.py')) {
              throw new ValidationError(`"${request.path}" is not a Python file — the function layer only supports .py files`);
            }

            const [content] = await fetchAllContents(owner, repo, [entry]);
            return { sourceOwner: owner, sourceRepo: repo, resolvedSha, path: entry.path, content: content || '' };
          })(),
          config.graphAnalysisTimeoutMs,
          `Function analysis did not complete within ${config.graphAnalysisTimeoutMs}ms`
        );
      } catch (err) {
        const durationMs = Date.now() - startedAtMs;
        if (err instanceof GraphAnalysisTimeoutError) {
          log.warn('graph-function analysis timed out', { path: request.path, durationMs });
          return sendError(res, 504, err.message, 'timeout', requestId);
        }
        if (err instanceof ValidationError) {
          log.warn('rejected graph-function request: path resolution failed', { message: err.message });
          return sendError(res, 400, err.message, 'unsupported_input', requestId);
        }
        if (err instanceof AnalysisContextError) {
          log.warn('rejected graph-function request: PR revision changed since the parent graph was loaded', { message: err.message });
          return sendError(
            res,
            409,
            'The pull request has changed since the file graph was loaded. Refresh the file graph and try again.',
            'unsupported_input',
            requestId
          );
        }
        if (err instanceof GithubFetchError) {
          const rateLimited = RATE_LIMIT_PATTERN.test(err.message);
          log.warn('github fetch failed', { message: err.message, rateLimited, durationMs });
          return sendError(res, rateLimited ? 429 : 502, err.message, 'github_access', requestId, { retryable: rateLimited });
        }
        log.error('function source retrieval failed', { message: err && err.message, durationMs });
        return sendError(res, 502, 'Function analysis failed while retrieving its source', 'github_access', requestId);
      }

      // Symbol resolution: identify the exact function via MOO-70's
      // canonical symbol index, never a position/name-based guess.
      let entry;
      // MOO-71 Commit 10: byte ranges of every parse error in this file.
      // Captured here (the symbol index already walks the tree for
      // tree.rootNode.hasError()) because it is the only evidence available
      // for telling an unparseable source apart from a genuine bug on our
      // side when CodeVisualizer later fails to find the function -- see the
      // FunctionRangeNotFoundError handler below. Kept as ranges rather than
      // one file-wide boolean so that check can be scoped to the target
      // function's own byte span, not "anywhere in the file".
      let errorRanges = [];
      try {
        const indexed = await indexPythonSymbols({ path: resolved.path, content: resolved.content });
        errorRanges = indexed.errorRanges;
        const result = resolveFunctionSymbol(indexed.entries, request.symbolPath);
        if (result.outcome === 'unresolved') {
          log.warn('rejected graph-function request: no matching symbol', { path: request.path, symbolPath: request.symbolPath });
          return sendError(res, 404, 'No function found at this path/symbolPath in this revision.', 'unsupported_input', requestId);
        }
        if (result.outcome === 'ambiguous') {
          log.warn('rejected graph-function request: ambiguous symbol', { path: request.path, symbolPath: request.symbolPath, count: result.count });
          return sendError(res, 400, 'Multiple symbols match this coordinate; cannot resolve unambiguously.', 'unsupported_input', requestId);
        }
        entry = result.entry;
        if (entry.symbolKind !== 'function' && entry.symbolKind !== 'method') {
          log.warn('rejected graph-function request: symbol is not a function/method', { symbolKind: entry.symbolKind });
          return sendError(res, 400, `Target symbol is a ${entry.symbolKind}, not a function or method.`, 'unsupported_input', requestId);
        }
      } catch (err) {
        const durationMs = Date.now() - startedAtMs;
        log.error('symbol indexing failed', { message: err && err.message, durationMs });
        return sendError(res, 500, 'Analysis failed while indexing the file’s symbols', 'internal_error', requestId);
      }

      // MOO-72 Commit 2: cache lookup sits between symbol resolution (fast
      // -- one tree-sitter parse of an already-fetched file) and the
      // CodeVisualizer run below, which is this route's expensive step. The
      // resolved `entry` is what makes the key exact: the graph's eventual
      // rootCoordinate is built from that same entry, so the key computed
      // here and the artifact it stores describe the same function,
      // including its source range.
      let cacheKey;
      let cacheContext;
      try {
        cacheContext = buildRequestContext(request, resolved);
        cacheKey = buildCacheKey({
          context: cacheContext,
          analyzerName: ANALYZER.name,
          analyzerVersion: ANALYZER.version,
          graphSchemaVersion: GRAPH_IR_SCHEMA_VERSION,
          // Mirrors functionGraphAdapter.js's own rootCoordinate construction.
          coordinate: makeCoordinate({
            repository: { host: 'github.com', owner: cacheContext.sourceOwner, name: cacheContext.sourceRepo },
            revision: cacheContext.resolvedSha,
            path: entry.path,
            symbolPath: entry.symbolPath,
            symbolKind: entry.symbolKind,
            range: {
              startLine: entry.startLine,
              startColumn: entry.startColumn,
              endLine: entry.endLine,
              endColumn: entry.endColumn,
            },
          }),
          options: cacheKeyRequestIdentity(cacheContext),
        });
      } catch (err) {
        if (err instanceof AnalysisContextError) {
          log.warn('graph-function contract violation while building the cache key', { message: err.message });
          return sendError(res, 502, 'The analyzed function could not be represented as a valid graph', 'malformed_analyzer_output', requestId);
        }
        throw err;
      }

      const cachedGraph = cache.get(cacheKey);
      if (cachedGraph) {
        const durationMs = Date.now() - startedAtMs;
        log.info('graph-function cache hit', {
          owner: request.owner,
          repo: request.repo,
          path: request.path,
          symbolPath: request.symbolPath,
          resolvedSha: resolved.resolvedSha,
          durationMs,
          nodeCount: cachedGraph.nodes.length,
          edgeCount: cachedGraph.edges.length,
          cacheKey,
          cacheHit: true,
        });
        return sendJson(res, 200, buildAdapterResult({
          graph: cachedGraph,
          warnings: cachedGraph.warnings,
          provenance: { analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version },
          timing: { startedAt, durationMs },
          cache: { key: cacheKey, hit: true },
        }));
      }

      // CodeVisualizer call: convert the symbol index's line/column
      // range into the flat index @codevisualizer/core expects, then
      // request the exact function by that range (never by position or
      // name, for the same "no guessing" reason as symbol resolution
      // above).
      let flowchartIR;
      try {
        const startByte = lineColumnToCodeUnitOffset(resolved.content, entry.startLine, entry.startColumn);
        const endByte = lineColumnToCodeUnitOffset(resolved.content, entry.endLine, entry.endColumn);
        flowchartIR = await analyzePythonFunction(resolved.content, { startByte, endByte });
      } catch (err) {
        const durationMs = Date.now() - startedAtMs;
        if (err.name === 'FunctionRangeNotFoundError') {
          // This one error covers two genuinely different situations, and
          // reporting them identically was actively misleading.
          //
          // tree-sitter is error-tolerant: it never throws on a syntax error,
          // it produces a tree containing ERROR nodes. So source that does not
          // parse does not surface as some distinct "parse error" -- it
          // surfaces here, as "no function definition matches that exact
          // range". Previously every occurrence was reported as
          // "Internal conversion error", i.e. we told the user we had a bug
          // when their file simply wasn't valid Python.
          //
          // `errorRanges` (from the symbol index, which already walked the
          // tree for tree.rootNode.hasError()) is the evidence that separates
          // them, scoped to this target function's own byte range rather than
          // the whole file:
          //   - a parse error inside [startByte, endByte) -> the source is at
          //     fault. parser_failure, the same category pyan3's adapter
          //     already uses for the same situation at the file layer.
          //   - none in range   -> the target function parses fine and our
          //     offset conversion genuinely disagrees with CodeVisualizer's
          //     tree. That is our bug, and keeps malformed_analyzer_output --
          //     even if some *other* function in the file fails to parse.
          const classified = classifyFunctionRangeFailure({
            errorRanges,
            startByte: err.startByte,
            endByte: err.endByte,
          });
          if (classified.category === 'parser_failure') {
            log.warn('CodeVisualizer could not locate the function in source that fails to parse', {
              path: request.path,
              symbolPath: request.symbolPath,
              startByte: err.startByte,
              endByte: err.endByte,
              durationMs,
            });
          } else {
            log.error('byte-offset conversion did not match @codevisualizer/core’s own parse', {
              message: err.message,
              startByte: err.startByte,
              endByte: err.endByte,
              durationMs,
            });
          }
          return sendError(res, classified.status, classified.message, classified.category, requestId);
        }
        log.error('CodeVisualizer analysis failed', { message: err && err.message, durationMs });
        return sendError(res, 500, 'Analysis failed while generating the function flowchart', 'internal_error', requestId);
      }

      // Phase 2: pure glue, no more network/subprocess calls -- convert
      // FlowchartIR into GraphIR (MOO-71 Commit 6), mirroring
      // graph-file.js's own phase 2 error handling exactly.
      let graph;
      try {
        graph = adaptFunctionAnalysis({ context: cacheContext, entrySymbol: entry, source: resolved.content, flowchartIR, analyzer: ANALYZER });
      } catch (err) {
        if (err instanceof AnalysisContextError) {
          log.warn('graph-function contract violation during graph construction', { message: err.message });
          return sendError(res, 502, 'The analyzed function could not be represented as a valid graph', 'malformed_analyzer_output', requestId);
        }
        const durationMs = Date.now() - startedAtMs;
        log.error('graph construction failed (GraphIR conversion)', { message: err && err.message, durationMs });
        return sendError(res, 500, 'Analysis failed while building the function graph', 'internal_error', requestId);
      }

      // No degraded mode at this layer -- there is no fallback analyzer, so
      // any graph that reaches here is a full-fidelity result.
      cache.set(cacheKey, graph);

      const durationMs = Date.now() - startedAtMs;
      const adapterResult = buildAdapterResult({
        graph,
        warnings: graph.warnings,
        provenance: { analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version },
        timing: { startedAt, durationMs },
        cache: { key: cacheKey, hit: false },
      });

      log.info('graph-function analysis complete', {
        owner: request.owner,
        repo: request.repo,
        path: request.path,
        symbolPath: request.symbolPath,
        sourceOwner: resolved.sourceOwner,
        sourceRepo: resolved.sourceRepo,
        resolvedSha: resolved.resolvedSha,
        analyzerName: ANALYZER.name,
        analyzerVersion: ANALYZER.version,
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
        log.warn('graph-function contract violation', { message: err.message });
        return sendError(res, 502, 'The analyzed function could not be represented as a valid graph', 'malformed_analyzer_output', requestId);
      }
      log.error('graph-function internal error', { message: err && err.message });
      sendError(res, 500, 'Analysis failed', 'internal_error', requestId);
    }
  };
}
