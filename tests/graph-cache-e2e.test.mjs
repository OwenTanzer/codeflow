// End-to-end cache behavior through the real route handlers — MOO-72 Commit 2.
//
// src/analyzer.js's GitHub client goes through the global `fetch`, so
// stubbing that one function is enough to drive a complete
// /api/graph/repository request -- validation, ref resolution, tree/blob
// fetching, analysis, GraphIR conversion, caching -- with no credential and
// no network. That makes the claim this whole commit rests on directly
// testable: a repeat request must skip the expensive work rather than
// merely reporting `hit: true`.
//
// Counting GitHub calls is the assertion that actually matters. A cache
// that returned the right bytes while still re-fetching and re-parsing
// everything would satisfy a `cache.hit === true` check and deliver none of
// the benefit; the call count is what distinguishes the two.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { GraphCache } from '../server/lib/graph-cache.js';
import { Metrics } from '../server/lib/metrics.js';
import { createGraphRepositoryHandler } from '../server/routes/graph-repository.js';

const SHA = 'c'.repeat(40);

const FILES = {
  'app.py': 'def main():\n    helper()\n\ndef helper():\n    return 1\n',
  'util.js': 'export function add(a, b) { return a + b; }\n',
};
const BLOB_SHAS = Object.fromEntries(Object.keys(FILES).map((p, i) => [p, `blob${i}`.padEnd(40, '0')]));

const CONFIG = {
  maxRequestBodyBytes: 16 * 1024,
  allowedRepos: [],
  allowedOwners: ['octocat'],
  githubToken: 'fake-token',
  graphAnalysisTimeoutMs: 30_000,
  maxRepoFiles: 750,
  maxFileBytes: 1_000_000,
  maxRepoBytes: 25_000_000,
};

/**
 * Install a fetch stub that serves the fixture repository above and counts
 * calls. Returns a counter object; call `restore()` when done.
 */
function stubGitHub() {
  const original = globalThis.fetch;
  const state = { calls: 0, restore: () => { globalThis.fetch = original; } };

  globalThis.fetch = async (url) => {
    state.calls += 1;
    const u = String(url);
    const json = (body) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => body,
      text: async () => JSON.stringify(body),
    });

    if (/\/repos\/[^/]+\/[^/]+$/.test(u)) return json({ default_branch: 'main' });
    if (u.includes('/commits/')) return json({ sha: SHA });
    if (u.includes('/git/trees/')) {
      return json({
        truncated: false,
        tree: Object.keys(FILES).map((p) => ({ type: 'blob', path: p, sha: BLOB_SHAS[p], size: FILES[p].length })),
      });
    }
    if (u.includes('/git/blobs/')) {
      const path = Object.keys(BLOB_SHAS).find((p) => u.endsWith(BLOB_SHAS[p]));
      return json({ encoding: 'base64', content: Buffer.from(FILES[path], 'utf8').toString('base64') });
    }
    throw new Error('unexpected GitHub URL in test stub: ' + u);
  };

  return state;
}

function fakeResponse() {
  return {
    statusCode: 0,
    body: null,
    writeHead(status) { this.statusCode = status; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; },
  };
}

function makeHarness({ enabled = true } = {}) {
  const cache = new GraphCache({ maxItems: 10, maxBytes: 50_000_000, ttlMs: 60_000, enabled });
  const metrics = new Metrics();
  const handler = createGraphRepositoryHandler({ config: CONFIG, cache, metrics });
  const github = stubGitHub();

  return {
    cache,
    metrics,
    github,
    async request(body, requestId = 'test') {
      github.calls = 0;
      const res = fakeResponse();
      await handler(Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]), res, requestId);
      assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
      return { ...res.body, githubCalls: github.calls };
    },
  };
}

const BASE_REQUEST = { owner: 'octocat', repo: 'Hello-World' };

test('a repeat request is served from cache without re-fetching or re-parsing the repository', async (t) => {
  const h = makeHarness();
  t.after(h.github.restore);

  const first = await h.request(BASE_REQUEST, 'first');
  const second = await h.request(BASE_REQUEST, 'second');

  assert.equal(first.cache.hit, false, 'the first request is a miss');
  assert.equal(second.cache.hit, true, 'the second request is a hit');
  assert.equal(first.cache.key, second.cache.key, 'both requests resolve to the same key');

  // The substance of the commit: the hit skipped the tree listing and every
  // blob fetch, making only the cheap ref-resolution calls needed to build
  // the key in the first place.
  assert.ok(
    second.githubCalls < first.githubCalls,
    `expected the cache hit to make fewer GitHub calls (first=${first.githubCalls}, second=${second.githubCalls})`
  );
});

test('a cached response carries the same graph as the uncached one', async (t) => {
  const h = makeHarness();
  t.after(h.github.restore);

  const first = await h.request(BASE_REQUEST, 'first');
  const second = await h.request(BASE_REQUEST, 'second');

  assert.deepEqual(second.graph, first.graph, 'cached and freshly-analyzed graphs are deeply equal');
  assert.deepEqual(second.warnings, first.warnings);
  assert.deepEqual(second.provenance.analyzerName, first.provenance.analyzerName);
  assert.ok(first.graph.nodes.length > 0, 'the fixture actually produced a non-trivial graph');
});

test('a cache hit reports its own timing rather than replaying the original analysis duration', async (t) => {
  const h = makeHarness();
  t.after(h.github.restore);

  const first = await h.request(BASE_REQUEST, 'first');
  const second = await h.request(BASE_REQUEST, 'second');

  assert.notEqual(second.timing.startedAt, first.timing.startedAt, 'the hit timestamps this request');
  assert.equal(typeof second.timing.durationMs, 'number');
  assert.ok(second.timing.durationMs >= 0);
});

test('serving a hit does not corrupt the stored entry, so a third request still succeeds', async (t) => {
  const h = makeHarness();
  t.after(h.github.restore);

  const first = await h.request(BASE_REQUEST, 'first');
  await h.request(BASE_REQUEST, 'second');
  const third = await h.request(BASE_REQUEST, 'third');

  assert.equal(third.cache.hit, true);
  assert.deepEqual(third.graph, first.graph, 'the stored graph survived two responses being built from it');
  assert.equal(h.cache.size, 1, 'still exactly one entry -- hits did not duplicate it');
});

test('exclude patterns differing only in case, order, or whitespace hit the same entry', async (t) => {
  const h = makeHarness();
  t.after(h.github.restore);

  const a = await h.request({ ...BASE_REQUEST, excludePatterns: ['DIST', 'node_modules'] }, 'a');
  const b = await h.request({ ...BASE_REQUEST, excludePatterns: ['  node_modules ', 'dist'] }, 'b');

  assert.equal(a.cache.key, b.cache.key);
  assert.equal(a.cache.hit, false);
  assert.equal(b.cache.hit, true, 'the equivalent request was served from the first one\'s entry');

  // Sharing a cache entry must not mean sharing a's exact casing/order in b's
  // response: each request's returned metadata should reflect what *it* sent.
  assert.deepEqual(a.graph.metadata.excludePatterns, ['DIST', 'node_modules']);
  assert.deepEqual(b.graph.metadata.excludePatterns, ['node_modules', 'dist']);
});

test('genuinely different exclude patterns do not share an entry', async (t) => {
  const h = makeHarness();
  t.after(h.github.restore);

  const a = await h.request({ ...BASE_REQUEST, excludePatterns: ['dist'] }, 'a');
  const b = await h.request({ ...BASE_REQUEST, excludePatterns: ['build'] }, 'b');

  assert.notEqual(a.cache.key, b.cache.key);
  assert.equal(b.cache.hit, false);
});

test('an explicit branch request does not reuse the default-branch entry at the same SHA', async (t) => {
  const h = makeHarness();
  t.after(h.github.restore);

  // Both resolve to the same commit, but their responses must carry
  // different graph.context values (mode 'repository' vs 'branch'), so
  // sharing an entry would serve one request the other's context.
  const defaultBranch = await h.request(BASE_REQUEST, 'default');
  const explicitBranch = await h.request({ ...BASE_REQUEST, ref: 'main' }, 'branch');

  assert.equal(defaultBranch.graph.context.resolvedSha, explicitBranch.graph.context.resolvedSha, 'same commit');
  assert.notEqual(defaultBranch.cache.key, explicitBranch.cache.key);
  assert.equal(explicitBranch.cache.hit, false);
  assert.equal(defaultBranch.graph.context.mode, 'repository');
  assert.equal(explicitBranch.graph.context.mode, 'branch');
  assert.equal(explicitBranch.graph.context.ref, 'main');
});

test('CACHE_ENABLED=false leaves every request a miss and stores nothing', async (t) => {
  const h = makeHarness({ enabled: false });
  t.after(h.github.restore);

  const first = await h.request(BASE_REQUEST, 'first');
  const second = await h.request(BASE_REQUEST, 'second');

  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.hit, false);
  assert.equal(h.cache.size, 0, 'nothing was stored');
  assert.equal(second.githubCalls, first.githubCalls, 'the full analysis ran both times');
  // Everything except generatedAt, which is genuinely two separate analyses
  // at two separate instants -- that it differs here (and does *not* differ
  // across a cache hit) is exactly right.
  assert.deepEqual({ ...second.graph, generatedAt: null }, { ...first.graph, generatedAt: null },
    'behavior is otherwise unchanged');
});

test('an expired entry re-runs the analysis instead of serving stale content', async (t) => {
  const cache = new GraphCache({ maxItems: 10, maxBytes: 50_000_000, ttlMs: 1000, enabled: true });
  const handler = createGraphRepositoryHandler({ config: CONFIG, cache, metrics: new Metrics() });
  const github = stubGitHub();
  t.after(github.restore);

  async function request(requestId) {
    github.calls = 0;
    const res = fakeResponse();
    await handler(Readable.from([Buffer.from(JSON.stringify(BASE_REQUEST), 'utf8')]), res, requestId);
    return { ...res.body, githubCalls: github.calls };
  }

  const first = await request('first');
  assert.equal(first.cache.hit, false);

  // Freeze time past the TTL. Mocked only now, so the request above ran
  // against the real clock.
  const realNow = Date.now();
  t.mock.method(Date, 'now', () => realNow + 5000);

  const afterExpiry = await request('after-expiry');
  assert.equal(afterExpiry.cache.hit, false, 'the expired entry was not served');
  assert.equal(afterExpiry.githubCalls, first.githubCalls, 'the full analysis ran again');
});
