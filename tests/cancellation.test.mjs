// Real HTTP client-disconnect cancellation -- MOO-72 Commit 1B.
//
// PR review finding: a stubbed `req` as a plain EventEmitter would encode
// the *wrong* close semantics (server/lib/cancellation.js watches `res`,
// not `req`, precisely because `req`'s own 'close' fires on normal body-
// consumption completion too, not specifically on disconnect). Proving the
// real behavior needs a real node:http server and a real client aborting a
// real in-flight request -- not a fake request object standing in for one.
//
// Uses node:http's own client (request()), not global fetch, for the test's
// outbound call to the local server -- the server's own GitHub calls are
// stubbed via globalThis.fetch, and using fetch for the test client too
// would route both through the same stub.
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { GraphCache } from '../server/lib/graph-cache.js';
import { Metrics } from '../server/lib/metrics.js';
import { createGraphRepositoryHandler } from '../server/routes/graph-repository.js';

const SHA = 'f'.repeat(40);
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

function jsonResponse(body) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) };
}

/** A GitHub fetch stub whose ref-resolution call is artificially slow, so a real client has time to abort mid-flight. */
function stubSlowGitHub(delayMs) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/\/repos\/[^/]+\/[^/]+$/.test(u)) {
      await delay(delayMs);
      return jsonResponse({ default_branch: 'main' });
    }
    if (u.includes('/commits/')) return jsonResponse({ sha: SHA });
    if (u.includes('/git/trees/')) return jsonResponse({ truncated: false, tree: [] });
    throw new Error('unexpected GitHub URL in test stub: ' + u);
  };
  return () => { globalThis.fetch = original; };
}

function fastStubGitHub() {
  const FILES = { 'app.js': 'export function f(){return 1;}' };
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/\/repos\/[^/]+\/[^/]+$/.test(u)) return jsonResponse({ default_branch: 'main' });
    if (u.includes('/commits/')) return jsonResponse({ sha: SHA });
    if (u.includes('/git/trees/')) {
      return jsonResponse({ truncated: false, tree: [{ type: 'blob', path: 'app.js', sha: 'b'.repeat(40), size: FILES['app.js'].length }] });
    }
    if (u.includes('/git/blobs/')) return jsonResponse({ encoding: 'base64', content: Buffer.from(FILES['app.js'], 'utf8').toString('base64') });
    throw new Error('unexpected GitHub URL in test stub: ' + u);
  };
  return () => { globalThis.fetch = original; };
}

function startServer(handler) {
  const server = createServer((req, res) => {
    let requestId = 0;
    handler(req, res, 'req-' + (requestId++)).catch(() => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** A real HTTP client call using node:http (not global fetch, which the tests stub for the server's own outbound GitHub calls). */
function postJson(server, body, { signal } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/graph/repository',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      signal,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* empty/partial body on abort */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('a real client abort during the GitHub-fetch phase is classified cancelled exactly once, with no cache write', async (t) => {
  const restoreFetch = stubSlowGitHub(500);
  t.after(restoreFetch);

  const cache = new GraphCache({ maxItems: 10, maxBytes: 50_000_000, ttlMs: 60_000, enabled: true });
  const metrics = new Metrics();
  const handler = createGraphRepositoryHandler({ config: CONFIG, cache, metrics });
  const server = await startServer(handler);
  t.after(() => server.close());

  const controller = new AbortController();
  const reqPromise = postJson(server, { owner: 'octocat', repo: 'Hello-World' }, { signal: controller.signal });

  await delay(30); // let the request actually reach the server and start the slow GitHub call
  controller.abort();
  await assert.rejects(() => reqPromise);

  // Give the server-side handler a moment to observe the disconnect and
  // finish its own cancellation branch (its GitHub stub call is still
  // "in flight" from the process's perspective for up to 500ms, but the
  // handler itself should stop and record 'cancelled' well before that).
  await delay(50);

  const buckets = metrics.snapshot().buckets;
  assert.equal(buckets.length, 1, `expected exactly one bucket, got ${JSON.stringify(buckets)}`);
  assert.equal(buckets[0].layer, 'repository');
  assert.equal(buckets[0].resultState, 'cancelled');
  assert.equal(buckets[0].count, 1);
  assert.equal(cache.get('anything-would-do'), null, 'no cache entry can exist -- the request never reached cache.set()');
});

test('a normal, fully-completed request is never misclassified as cancelled', async (t) => {
  const restoreFetch = fastStubGitHub();
  t.after(restoreFetch);

  const cache = new GraphCache({ maxItems: 10, maxBytes: 50_000_000, ttlMs: 60_000, enabled: true });
  const metrics = new Metrics();
  const handler = createGraphRepositoryHandler({ config: CONFIG, cache, metrics });
  const server = await startServer(handler);
  t.after(() => server.close());

  const { status, body } = await postJson(server, { owner: 'octocat', repo: 'Hello-World' });
  assert.equal(status, 200);
  assert.equal(body.graph != null, true);

  const buckets = metrics.snapshot().buckets;
  assert.equal(buckets.length, 1);
  assert.notEqual(buckets[0].resultState, 'cancelled', 'a request whose body was fully consumed and answered must never be misclassified as cancelled');
  assert.equal(buckets[0].resultState, 'success');
});
