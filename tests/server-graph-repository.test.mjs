// Unit tests for server/routes/graph-repository.js's pure context-building
// logic (MOO-69 Commit 2). The full HTTP handler needs a real GitHub
// credential to exercise end-to-end (same as /api/analyze-repo) -- see
// tests/server-smoke.mjs's "graph-repository" steps for that coverage; this
// file covers what's unit-testable without network access.
import assert from 'node:assert/strict';
import test from 'node:test';

const { buildRequestContext, withTimeout, GraphAnalysisTimeoutError, RATE_LIMIT_PATTERN, derivePythonParserCapability } = await import('../server/routes/graph-repository.js');
const { buildCacheKey } = await import('../src/graph-ir/cacheKey.js');
const { normalizeContext } = await import('../src/graph-ir/githubContext.js');

const SHA = 'a'.repeat(40);

test('a whole-repository request (no ref, no pr) normalizes to mode "repository"', () => {
  const request = { owner: 'octocat', repo: 'Hello-World', ref: null, pr: null };
  const resolved = { sourceOwner: 'octocat', sourceRepo: 'Hello-World', resolvedSha: SHA };
  const context = buildRequestContext(request, resolved);
  assert.equal(context.mode, 'repository');
  assert.equal(context.resolvedSha, SHA);
});

test('a branch request normalizes to mode "branch" and preserves the ref', () => {
  const request = { owner: 'octocat', repo: 'Hello-World', ref: 'main', pr: null };
  const resolved = { sourceOwner: 'octocat', sourceRepo: 'Hello-World', resolvedSha: SHA };
  const context = buildRequestContext(request, resolved);
  assert.equal(context.mode, 'branch');
  assert.equal(context.ref, 'main');
});

test('a PR request normalizes to mode "pr" and carries the resolved fork source repository', () => {
  const request = { owner: 'octocat', repo: 'Hello-World', ref: null, pr: 10590 };
  const resolved = { sourceOwner: 'angelg84', sourceRepo: 'Hello-World', resolvedSha: SHA };
  const context = buildRequestContext(request, resolved);
  assert.equal(context.mode, 'pr');
  assert.equal(context.prNumber, 10590);
  assert.equal(context.owner, 'octocat', 'base repository preserved for provenance/allowlist identity');
  assert.equal(context.sourceOwner, 'angelg84', 'source repository is the resolved fork');
});

test('a same-repository PR (no fork) still normalizes cleanly with sourceOwner/sourceRepo equal to the base', () => {
  const request = { owner: 'octocat', repo: 'Hello-World', ref: null, pr: 5 };
  const resolved = { sourceOwner: 'octocat', sourceRepo: 'Hello-World', resolvedSha: SHA };
  const context = buildRequestContext(request, resolved);
  assert.equal(context.sourceOwner, 'octocat');
  assert.equal(context.sourceRepo, 'Hello-World');
});

test('withTimeout resolves normally when the wrapped promise finishes first', async () => {
  const result = await withTimeout(Promise.resolve('done'), 1000, 'should not fire');
  assert.equal(result, 'done');
});

test('withTimeout rejects with GraphAnalysisTimeoutError when the wrapped promise is too slow', async () => {
  const neverResolves = new Promise(() => {});
  await assert.rejects(() => withTimeout(neverResolves, 20, 'took too long'), (err) => {
    assert.ok(err instanceof GraphAnalysisTimeoutError);
    assert.equal(err.message, 'took too long');
    return true;
  });
});

test('withTimeout propagates the wrapped promise\'s own rejection (not a timeout) when it fails first', async () => {
  await assert.rejects(() => withTimeout(Promise.reject(new Error('real failure')), 1000, 'should not fire'), /real failure/);
});

test('RATE_LIMIT_PATTERN matches GitHub\'s real rate-limit error text', () => {
  assert.equal(RATE_LIMIT_PATTERN.test('API rate limit exceeded for 1.2.3.4.'), true);
  assert.equal(RATE_LIMIT_PATTERN.test('Ref not found (branch, commit, or PR head does not exist)'), false);
  assert.equal(RATE_LIMIT_PATTERN.test('Repository not found'), false);
});

// MOO-72 Commit 1A review (round 3): installNodeTreeSitter can silently
// fall back to an undefined globalThis.TreeSitter, and nothing about that
// previously changed the cache key -- derivePythonParserCapability derives
// the *effective* capability from the already-computed per-node
// parserProvenance (not a fresh ambient-global check), so the route can
// fold it into the cache key and warn on degradation.
function pyNode(provenance) {
  return { coordinate: { path: 'a.py' }, metadata: { parserProvenance: provenance } };
}
function jsNode(provenance) {
  return { coordinate: { path: 'a.js' }, metadata: { parserProvenance: provenance } };
}

test('derivePythonParserCapability reports active when a Python node used real tree-sitter', () => {
  const graph = { nodes: [pyNode('tree-sitter:python-calls'), jsNode('acorn')] };
  const capability = derivePythonParserCapability(graph);
  assert.equal(capability.pythonFileCount, 1);
  assert.equal(capability.pythonTreeSitterActive, true);
});

test('derivePythonParserCapability reports inactive when Python files exist but none show tree-sitter provenance', () => {
  const graph = { nodes: [pyNode('heuristic-regex'), pyNode(null)] };
  const capability = derivePythonParserCapability(graph);
  assert.equal(capability.pythonFileCount, 2);
  assert.equal(capability.pythonTreeSitterActive, false);
});

test('derivePythonParserCapability reports zero Python files for a repo with none', () => {
  const graph = { nodes: [jsNode('acorn'), jsNode('acorn-babel')] };
  const capability = derivePythonParserCapability(graph);
  assert.equal(capability.pythonFileCount, 0);
  assert.equal(capability.pythonTreeSitterActive, false);
});

test('the same repository/revision/options/analyzer identity produces a different cache key when effective Python parser capability differs', () => {
  const context = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA });
  const baseParams = {
    context,
    analyzerName: 'codeflow-repository-adapter',
    analyzerVersion: '1.2.0',
    graphSchemaVersion: 1,
  };
  const keyWithTreeSitter = buildCacheKey({ ...baseParams, options: { excludePatterns: [], pythonTreeSitter: true } });
  const keyWithoutTreeSitter = buildCacheKey({ ...baseParams, options: { excludePatterns: [], pythonTreeSitter: false } });
  assert.notEqual(keyWithTreeSitter, keyWithoutTreeSitter, 'a materially different effective analyzer capability must not collide on the same cache key');
});
