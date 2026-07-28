// Cache identity and route-integration tests for MOO-72 Commit 2.
//
// The three graph handlers need a live GitHub credential to exercise
// end-to-end (same constraint as tests/server-graph-repository.test.mjs),
// so this file covers the two things that are both testable without
// network access and where the actual correctness risk lives:
//
//  1. Cache *identity* -- that every dimension which changes the response
//     also changes the key, and that requests which mean the same thing
//     collapse to the same key. A key that under-discriminates silently
//     serves the wrong graph, which is the worst failure mode this commit
//     can have.
//  2. The handler's pre-network ordering -- that a request rejected by
//     validation or the allowlist never reaches the cache at all. This is
//     reachable without a credential precisely because those rejections
//     happen before any GitHub call.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { GraphCache } from '../server/lib/graph-cache.js';
import { Metrics } from '../server/lib/metrics.js';
import { cacheKeyRequestIdentity } from '../server/routes/graph-repository.js';
import { normalizeExcludePatterns } from '../server/lib/github-analyzer-bridge.js';
import { buildCacheKey } from '../src/graph-ir/cacheKey.js';
import { normalizeContext } from '../src/graph-ir/githubContext.js';
import { makeCoordinate } from '../src/graph-ir/sourceCoordinate.js';
import { GRAPH_IR_SCHEMA_VERSION } from '../src/graph-ir/graphIR.js';
import { buildAdapterResult } from '../src/graph-ir/adapterResult.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const REPO_ANALYZER = { name: 'codeflow-repository-adapter', version: '1.2.0' };

/** Mirrors graph-repository.js's own key construction. */
function repositoryKey({ context, excludePatterns = [], pythonTreeSitter = true, analyzer = REPO_ANALYZER }) {
  return buildCacheKey({
    context,
    analyzerName: analyzer.name,
    analyzerVersion: analyzer.version,
    graphSchemaVersion: GRAPH_IR_SCHEMA_VERSION,
    options: {
      excludePatterns: normalizeExcludePatterns(excludePatterns),
      ...(pythonTreeSitter ? { pythonTreeSitter: true } : {}),
      ...cacheKeyRequestIdentity(context),
    },
  });
}

/** Mirrors graph-file.js's own key construction. */
function fileKey({ context, path, depth }) {
  return buildCacheKey({
    context,
    analyzerName: 'codeflow-pyan3-adapter',
    analyzerVersion: '1.0.0',
    graphSchemaVersion: GRAPH_IR_SCHEMA_VERSION,
    coordinate: makeCoordinate({
      repository: { host: 'github.com', owner: context.sourceOwner, name: context.sourceRepo },
      revision: context.resolvedSha,
      path,
      symbolKind: 'module',
    }),
    options: {
      depthMode: depth != null ? depth : 'auto',
      ...cacheKeyRequestIdentity(context),
    },
  });
}

const repositoryContext = normalizeContext({ owner: 'octocat', repo: 'Hello-World', mode: 'repository', resolvedSha: SHA });
const branchContext = normalizeContext({ owner: 'octocat', repo: 'Hello-World', mode: 'branch', ref: 'main', resolvedSha: SHA });

// --- Cache identity: collisions that would serve the wrong response ------

test('a default-branch and an explicit-branch request at the same SHA do not share a key', () => {
  // contextIdentityKey() alone keys on sourceOwner/sourceRepo@sha, so these
  // two would collide without cacheKeyRequestIdentity -- and they must not,
  // because their responses carry different graph.context values
  // (mode 'repository' + ref null vs mode 'branch' + ref 'main').
  assert.notEqual(repositoryKey({ context: repositoryContext }), repositoryKey({ context: branchContext }));
});

test('two different branch names resolving to the same SHA do not share a key', () => {
  const releaseContext = normalizeContext({ owner: 'octocat', repo: 'Hello-World', mode: 'branch', ref: 'release', resolvedSha: SHA });
  assert.notEqual(repositoryKey({ context: branchContext }), repositoryKey({ context: releaseContext }));
});

test('a PR request and a repository request at the same SHA do not share a key', () => {
  const prContext = normalizeContext({ owner: 'octocat', repo: 'Hello-World', mode: 'pr', prNumber: 7, resolvedSha: SHA });
  assert.notEqual(repositoryKey({ context: repositoryContext }), repositoryKey({ context: prContext }));
});

test('two different PRs converging on the same source SHA do not share a key', () => {
  const prA = normalizeContext({ owner: 'octocat', repo: 'Hello-World', mode: 'pr', prNumber: 7, resolvedSha: SHA });
  const prB = normalizeContext({ owner: 'octocat', repo: 'Hello-World', mode: 'pr', prNumber: 8, resolvedSha: SHA });
  assert.notEqual(repositoryKey({ context: prA }), repositoryKey({ context: prB }));
});

test('a forked PR keys off the fork it actually resolved to, not the base repository', () => {
  const base = normalizeContext({ owner: 'octocat', repo: 'Hello-World', mode: 'pr', prNumber: 7, resolvedSha: SHA });
  const fork = normalizeContext({
    owner: 'octocat', repo: 'Hello-World', mode: 'pr', prNumber: 7,
    resolvedSha: SHA, sourceOwner: 'contributor', sourceRepo: 'Hello-World',
  });
  assert.notEqual(repositoryKey({ context: base }), repositoryKey({ context: fork }));
});

// --- Cache identity: dimensions that must cause a miss ------------------

test('a different resolved SHA causes a miss', () => {
  const other = normalizeContext({ owner: 'octocat', repo: 'Hello-World', mode: 'repository', resolvedSha: OTHER_SHA });
  assert.notEqual(repositoryKey({ context: repositoryContext }), repositoryKey({ context: other }));
});

test('a different repository causes a miss', () => {
  const other = normalizeContext({ owner: 'octocat', repo: 'Spoon-Knife', mode: 'repository', resolvedSha: SHA });
  assert.notEqual(repositoryKey({ context: repositoryContext }), repositoryKey({ context: other }));
});

test('a bumped analyzer version causes a miss, so an adapter change cannot serve stale graphs', () => {
  assert.notEqual(
    repositoryKey({ context: repositoryContext }),
    repositoryKey({ context: repositoryContext, analyzer: { name: REPO_ANALYZER.name, version: '9.9.9' } })
  );
});

test('losing the Python tree-sitter grammar changes the key, so heuristic and tree-sitter graphs never share an entry', () => {
  assert.notEqual(
    repositoryKey({ context: repositoryContext, pythonTreeSitter: true }),
    repositoryKey({ context: repositoryContext, pythonTreeSitter: false })
  );
});

test('different exclude patterns cause a miss', () => {
  assert.notEqual(
    repositoryKey({ context: repositoryContext, excludePatterns: ['dist'] }),
    repositoryKey({ context: repositoryContext, excludePatterns: ['build'] })
  );
});

// --- Cache identity: requests that mean the same thing must collapse ----

test('exclude patterns differing only in order, case, or whitespace share one key', () => {
  const a = repositoryKey({ context: repositoryContext, excludePatterns: ['NODE_MODULES', 'dist'] });
  const b = repositoryKey({ context: repositoryContext, excludePatterns: ['  dist  ', 'node_modules'] });
  assert.equal(a, b);
});

test('duplicate exclude patterns collapse to the same key as the deduplicated form', () => {
  const a = repositoryKey({ context: repositoryContext, excludePatterns: ['dist', 'dist', 'dist'] });
  const b = repositoryKey({ context: repositoryContext, excludePatterns: ['dist'] });
  assert.equal(a, b);
});

test('normalizeExcludePatterns reuses the analyzer\'s own trimming/dedupe, then lowercases and sorts', () => {
  assert.deepEqual(normalizeExcludePatterns(['  Dist ', 'node_modules', 'DIST']), ['dist', 'node_modules']);
  assert.deepEqual(normalizeExcludePatterns([]), []);
  assert.deepEqual(normalizeExcludePatterns(undefined), []);
});

test('an empty exclude list and an omitted one share a key', () => {
  assert.equal(
    repositoryKey({ context: repositoryContext, excludePatterns: [] }),
    repositoryKey({ context: repositoryContext, excludePatterns: undefined })
  );
});

test('cacheKeyRequestIdentity carries ref only for branch mode', () => {
  assert.deepEqual(cacheKeyRequestIdentity(branchContext), { requestMode: 'branch', requestRef: 'main' });
  assert.deepEqual(cacheKeyRequestIdentity(repositoryContext), { requestMode: 'repository' });
});

// --- File-layer depth identity -----------------------------------------

test('file layer: two auto-depth requests for the same file share a key', () => {
  const a = fileKey({ context: repositoryContext, path: 'src/app.py' });
  const b = fileKey({ context: repositoryContext, path: 'src/app.py', depth: null });
  assert.equal(a, b);
});

test('file layer: an explicit depth override does not share the auto-depth key', () => {
  assert.notEqual(
    fileKey({ context: repositoryContext, path: 'src/app.py' }),
    fileKey({ context: repositoryContext, path: 'src/app.py', depth: 2 })
  );
});

test('file layer: two different depth overrides do not share a key', () => {
  assert.notEqual(
    fileKey({ context: repositoryContext, path: 'src/app.py', depth: 1 }),
    fileKey({ context: repositoryContext, path: 'src/app.py', depth: 2 })
  );
});

test('file layer: different paths at the same revision do not share a key', () => {
  assert.notEqual(
    fileKey({ context: repositoryContext, path: 'src/app.py' }),
    fileKey({ context: repositoryContext, path: 'src/other.py' })
  );
});

test('file and repository layers never collide, even for the same revision', () => {
  assert.notEqual(repositoryKey({ context: repositoryContext }), fileKey({ context: repositoryContext, path: 'src/app.py' }));
});

// --- Stored-entry integrity --------------------------------------------

function storedGraph() {
  return {
    schemaVersion: GRAPH_IR_SCHEMA_VERSION,
    layer: 'repository',
    context: repositoryContext,
    rootCoordinate: null,
    nodes: [],
    edges: [],
    groups: [],
    confidence: 1,
    warnings: ['a warning from the original analysis'],
    analyzer: { name: REPO_ANALYZER.name, version: REPO_ANALYZER.version },
    generatedAt: new Date().toISOString(),
    metrics: {},
  };
}

test('building a response from a cached graph does not mutate the stored entry', () => {
  const cache = new GraphCache({ maxItems: 10, maxBytes: 10_000_000, ttlMs: 60_000, enabled: true });
  const graph = storedGraph();
  const before = JSON.stringify(graph);
  cache.set('k', graph);

  // Two responses built from the same cached graph, as two cache hits would.
  buildAdapterResult({
    graph: cache.get('k'),
    warnings: cache.get('k').warnings,
    provenance: { analyzerName: REPO_ANALYZER.name, analyzerVersion: REPO_ANALYZER.version },
    timing: { startedAt: new Date().toISOString(), durationMs: 1 },
    cache: { key: 'k', hit: true },
  });
  buildAdapterResult({
    graph: cache.get('k'),
    warnings: cache.get('k').warnings,
    provenance: { analyzerName: REPO_ANALYZER.name, analyzerVersion: REPO_ANALYZER.version },
    timing: { startedAt: new Date().toISOString(), durationMs: 2 },
    cache: { key: 'k', hit: true },
  });

  assert.equal(JSON.stringify(cache.get('k')), before, 'the stored graph is byte-identical after two hits');
});

test('a cache hit reports this request\'s timing and hit:true, not the original analysis duration', () => {
  const cache = new GraphCache({ maxItems: 10, maxBytes: 10_000_000, ttlMs: 60_000, enabled: true });
  cache.set('k', storedGraph());

  const missStartedAt = '2020-01-01T00:00:00.000Z';
  const miss = buildAdapterResult({
    graph: storedGraph(),
    warnings: [],
    provenance: { analyzerName: REPO_ANALYZER.name, analyzerVersion: REPO_ANALYZER.version },
    timing: { startedAt: missStartedAt, durationMs: 9999 },
    cache: { key: 'k', hit: false },
  });

  const hitStartedAt = new Date().toISOString();
  const hit = buildAdapterResult({
    graph: cache.get('k'),
    warnings: cache.get('k').warnings,
    provenance: { analyzerName: REPO_ANALYZER.name, analyzerVersion: REPO_ANALYZER.version },
    timing: { startedAt: hitStartedAt, durationMs: 3 },
    cache: { key: 'k', hit: true },
  });

  assert.equal(miss.cache.hit, false);
  assert.equal(hit.cache.hit, true);
  assert.equal(hit.timing.durationMs, 3, 'not the 9999ms the original analysis took');
  assert.notEqual(hit.timing.startedAt, miss.timing.startedAt);
  assert.deepEqual(hit.graph.nodes, miss.graph.nodes, 'cached and uncached graphs are equivalent');
  assert.deepEqual(hit.warnings, ['a warning from the original analysis'], 'warnings survive the round trip');
});

// --- Handler ordering: rejections must never reach the cache ------------

/** A cache that fails the test if it is touched at all. */
function forbiddenCache() {
  return {
    get() { throw new Error('cache.get must not be called for a rejected request'); },
    set() { throw new Error('cache.set must not be called for a rejected request'); },
  };
}

function fakeRequest(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
}

// MOO-72 Commit 1B: a real EventEmitter (not a plain object) -- the route
// handlers' cancellation wiring calls res.once('close', ...)/res.off(...),
// which a plain object doesn't have.
function fakeResponse() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.body = null;
  res.writableEnded = false;
  res.writeHead = function (status) { this.statusCode = status; };
  res.end = function (payload) { this.body = payload ? JSON.parse(payload) : null; this.writableEnded = true; };
  return res;
}

const HANDLER_CONFIG = {
  maxRequestBodyBytes: 16 * 1024,
  allowedRepos: ['octocat/hello-world'],
  allowedOwners: [],
  githubToken: 'unused-because-no-request-gets-that-far',
  graphAnalysisTimeoutMs: 1000,
};

test('a repository request for a non-allowlisted repo is rejected before the cache is consulted', async () => {
  const { createGraphRepositoryHandler } = await import('../server/routes/graph-repository.js');
  const handler = createGraphRepositoryHandler({ config: HANDLER_CONFIG, cache: forbiddenCache(), metrics: new Metrics() });
  const res = fakeResponse();

  await handler(fakeRequest({ owner: 'attacker', repo: 'private-thing' }), res, 'req-1');

  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /not on the allowlist/);
});

test('a repository request that fails validation is rejected before the cache is consulted', async () => {
  const { createGraphRepositoryHandler } = await import('../server/routes/graph-repository.js');
  const handler = createGraphRepositoryHandler({ config: HANDLER_CONFIG, cache: forbiddenCache(), metrics: new Metrics() });
  const res = fakeResponse();

  await handler(fakeRequest({ repo: 'Hello-World' }), res, 'req-2');

  assert.equal(res.statusCode, 400);
});

test('a file request for a non-allowlisted repo is rejected before the cache is consulted', async () => {
  const { createGraphFileHandler } = await import('../server/routes/graph-file.js');
  const handler = createGraphFileHandler({
    config: HANDLER_CONFIG,
    workspaceManager: { createRequestWorkspace() { throw new Error('must not be reached'); } },
    cache: forbiddenCache(),
    metrics: new Metrics(),
  });
  const res = fakeResponse();

  await handler(fakeRequest({ owner: 'attacker', repo: 'private-thing', path: 'a.py' }), res, 'req-3');

  assert.equal(res.statusCode, 403);
});

test('a function request is rejected before the cache when CodeVisualizer is unavailable', async () => {
  const { createGraphFunctionHandler } = await import('../server/routes/graph-function.js');
  const handler = createGraphFunctionHandler({
    config: HANDLER_CONFIG,
    getCodeVisualizerAvailable: () => false,
    cache: forbiddenCache(),
    metrics: new Metrics(),
  });
  const res = fakeResponse();

  await handler(fakeRequest({ owner: 'octocat', repo: 'Hello-World', path: 'a.py', symbolPath: ['f'] }), res, 'req-4');

  assert.equal(res.statusCode, 502);
});

test('a function request for a non-allowlisted repo is rejected before the cache is consulted', async () => {
  const { createGraphFunctionHandler } = await import('../server/routes/graph-function.js');
  const handler = createGraphFunctionHandler({
    config: HANDLER_CONFIG,
    getCodeVisualizerAvailable: () => true,
    cache: forbiddenCache(),
    metrics: new Metrics(),
  });
  const res = fakeResponse();

  await handler(fakeRequest({ owner: 'attacker', repo: 'private-thing', path: 'a.py', symbolPath: ['f'] }), res, 'req-5');

  assert.equal(res.statusCode, 403);
});
