// Route-level telemetry contract tests -- MOO-72 Commit 3 PR review.
//
// tests/logger.test.mjs and tests/metrics.test.mjs each validate Logger and
// Metrics in isolation; neither catches a route handler that calls
// metrics.record() and log.warn()/log.info() with *different* resultState
// values for the same request, or that records a terminal metric twice for
// one request (both real bugs an earlier version of this commit had). This
// file drives each of the three real route handlers end-to-end (network
// stubbed, same technique as tests/graph-cache-e2e.test.mjs) and asserts
// the integration invariant those unit tests can't see: exactly one
// terminal metric, and its layer/resultState/cacheStatus exactly matching
// the one terminal structured log line for that same request.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { GraphCache } from '../server/lib/graph-cache.js';
import { Metrics } from '../server/lib/metrics.js';
import { WorkspaceManager } from '../server/lib/workspace.js';
import { createGraphRepositoryHandler } from '../server/routes/graph-repository.js';
import { createGraphFileHandler } from '../server/routes/graph-file.js';
import { createGraphFunctionHandler } from '../server/routes/graph-function.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHA = 'd'.repeat(40);
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

function fakeRequest(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
}

function fakeResponse() {
  return {
    statusCode: 0,
    body: null,
    writeHead(status) { this.statusCode = status; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; },
  };
}

/**
 * Same technique as tests/logger.test.mjs: capture what the real logger
 * writes. Tolerant of non-JSON chunks (e.g. a Node runtime warning) --
 * those are passed through to the real stream unchanged rather than
 * crashing the capture, since this file (unlike logger.test.mjs) also
 * exercises fetch/Headers/subprocess paths that can incidentally write to
 * stdout/stderr outside the logger.
 */
function captureWrites() {
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  const lines = [];
  const wrap = (original) => (chunk, ...rest) => {
    try {
      lines.push(JSON.parse(chunk));
      return true;
    } catch {
      return original(chunk, ...rest);
    }
  };
  process.stdout.write = wrap(originalStdout);
  process.stderr.write = wrap(originalStderr);
  return {
    lines,
    restore() {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
    },
  };
}

/** The one log line carrying a resultState -- the terminal outcome for this request. */
function terminalLogLine(lines) {
  const matches = lines.filter((l) => l.resultState != null);
  assert.equal(matches.length, 1, `expected exactly one terminal log line, got ${matches.length}: ${JSON.stringify(lines)}`);
  return matches[0];
}

/** Assert the metrics store recorded exactly one terminal outcome, matching the log line. */
function assertOneMatchingTerminalRecord(metrics, logLine) {
  const buckets = metrics.snapshot().buckets;
  assert.equal(buckets.length, 1, `expected exactly one metrics bucket, got ${buckets.length}: ${JSON.stringify(buckets)}`);
  const [bucket] = buckets;
  assert.equal(bucket.count, 1, 'expected exactly one terminal metric recorded for this one request');
  assert.equal(bucket.layer, logLine.layer);
  assert.equal(bucket.resultState, logLine.resultState);
  assert.equal(bucket.cacheStatus ?? null, logLine.cacheStatus ?? null);
  assert.equal(typeof logLine.durationMs, 'number');
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const REPO_FILES = { 'app.py': 'def main():\n    return 1\n' };
const REPO_BLOB_SHAS = Object.fromEntries(Object.keys(REPO_FILES).map((p, i) => [p, `blob${i}`.padEnd(40, '0')]));

function stubRepositoryGitHub() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/\/repos\/[^/]+\/[^/]+$/.test(u)) return jsonResponse({ default_branch: 'main' });
    if (u.includes('/commits/')) return jsonResponse({ sha: SHA });
    if (u.includes('/git/trees/')) {
      return jsonResponse({
        truncated: false,
        tree: Object.keys(REPO_FILES).map((p) => ({ type: 'blob', path: p, sha: REPO_BLOB_SHAS[p], size: REPO_FILES[p].length })),
      });
    }
    if (u.includes('/git/blobs/')) {
      const path = Object.keys(REPO_BLOB_SHAS).find((p) => u.endsWith(REPO_BLOB_SHAS[p]));
      return jsonResponse({ encoding: 'base64', content: Buffer.from(REPO_FILES[path], 'utf8').toString('base64') });
    }
    throw new Error('unexpected GitHub URL in test stub: ' + u);
  };
  return () => { globalThis.fetch = original; };
}

const REPO_CONFIG = {
  maxRequestBodyBytes: 16 * 1024,
  allowedRepos: [],
  allowedOwners: ['octocat'],
  githubToken: 'fake-token',
  graphAnalysisTimeoutMs: 30_000,
  maxRepoFiles: 750,
  maxFileBytes: 1_000_000,
  maxRepoBytes: 25_000_000,
};
const BASE_REPO_REQUEST = { owner: 'octocat', repo: 'Hello-World' };

test('repository layer: a fresh success is recorded once, with cacheStatus miss, matching the log line', async (t) => {
  const restore = stubRepositoryGitHub();
  t.after(restore);
  const cache = new GraphCache({ maxItems: 10, maxBytes: 50_000_000, ttlMs: 60_000, enabled: true });
  const metrics = new Metrics();
  const handler = createGraphRepositoryHandler({ config: REPO_CONFIG, cache, metrics });
  const capture = captureWrites();
  const res = fakeResponse();
  try {
    await handler(fakeRequest(BASE_REPO_REQUEST), res, 'req-success');
  } finally {
    capture.restore();
  }
  assert.equal(res.statusCode, 200);
  const logLine = terminalLogLine(capture.lines);
  assert.equal(logLine.layer, 'repository');
  assert.equal(logLine.resultState, 'success');
  assert.equal(logLine.cacheStatus, 'miss');
  assertOneMatchingTerminalRecord(metrics, logLine);
});

test('repository layer: a repeat request is a cache hit, recorded once, with cacheStatus hit', async (t) => {
  const restore = stubRepositoryGitHub();
  t.after(restore);
  const cache = new GraphCache({ maxItems: 10, maxBytes: 50_000_000, ttlMs: 60_000, enabled: true });
  const missMetrics = new Metrics();
  const handler = createGraphRepositoryHandler({ config: REPO_CONFIG, cache, metrics: missMetrics });

  // Prime the cache with a first (miss) request, using its own Metrics
  // instance so it doesn't pollute the hit assertion below.
  await handler(fakeRequest(BASE_REPO_REQUEST), fakeResponse(), 'req-prime');

  const hitMetrics = new Metrics();
  const hitHandler = createGraphRepositoryHandler({ config: REPO_CONFIG, cache, metrics: hitMetrics });
  const capture = captureWrites();
  const res = fakeResponse();
  try {
    await hitHandler(fakeRequest(BASE_REPO_REQUEST), res, 'req-hit');
  } finally {
    capture.restore();
  }
  assert.equal(res.statusCode, 200);
  const logLine = terminalLogLine(capture.lines);
  assert.equal(logLine.resultState, 'success');
  assert.equal(logLine.cacheStatus, 'hit');
  assertOneMatchingTerminalRecord(hitMetrics, logLine);
});

test('repository layer: a validation failure is recorded once as validation_error, no network reached', async () => {
  const cache = new GraphCache({ maxItems: 10, maxBytes: 50_000_000, ttlMs: 60_000, enabled: true });
  const metrics = new Metrics();
  const handler = createGraphRepositoryHandler({ config: REPO_CONFIG, cache, metrics });
  const capture = captureWrites();
  const res = fakeResponse();
  try {
    await handler(fakeRequest({ repo: 'Hello-World' }), res, 'req-invalid'); // missing owner
  } finally {
    capture.restore();
  }
  assert.equal(res.statusCode, 400);
  const logLine = terminalLogLine(capture.lines);
  assert.equal(logLine.resultState, 'validation_error');
  assert.equal(logLine.cacheStatus, undefined, 'validation_error never reaches a cache lookup');
  assertOneMatchingTerminalRecord(metrics, logLine);
});

test('repository layer: ref resolution timing out is recorded once as timeout', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = () => new Promise((resolve) => setTimeout(() => resolve(jsonResponse({ default_branch: 'main' })), 50));
  t.after(() => { globalThis.fetch = original; });

  const cache = new GraphCache({ maxItems: 10, maxBytes: 50_000_000, ttlMs: 60_000, enabled: true });
  const metrics = new Metrics();
  const handler = createGraphRepositoryHandler({
    config: { ...REPO_CONFIG, graphAnalysisTimeoutMs: 5 },
    cache,
    metrics,
  });
  const capture = captureWrites();
  const res = fakeResponse();
  try {
    await handler(fakeRequest(BASE_REPO_REQUEST), res, 'req-timeout');
  } finally {
    capture.restore();
  }
  assert.equal(res.statusCode, 504);
  const logLine = terminalLogLine(capture.lines);
  assert.equal(logLine.resultState, 'timeout');
  assertOneMatchingTerminalRecord(metrics, logLine);
});

test('function layer: CodeVisualizer unavailable is recorded once as dependency_unavailable, no network reached', async () => {
  const cache = new GraphCache({ maxItems: 10, maxBytes: 50_000_000, ttlMs: 60_000, enabled: true });
  const metrics = new Metrics();
  const handler = createGraphFunctionHandler({
    config: REPO_CONFIG,
    getCodeVisualizerAvailable: () => false,
    cache,
    metrics,
  });
  const capture = captureWrites();
  const res = fakeResponse();
  try {
    await handler(fakeRequest({ owner: 'octocat', repo: 'Hello-World', path: 'a.py', symbolPath: ['f'] }), res, 'req-dep');
  } finally {
    capture.restore();
  }
  assert.equal(res.statusCode, 502);
  const logLine = terminalLogLine(capture.lines);
  assert.equal(logLine.layer, 'function');
  assert.equal(logLine.resultState, 'dependency_unavailable');
  assertOneMatchingTerminalRecord(metrics, logLine);
});

// File layer: a real forced pyan3 failure (syntax_error.py, same fixture
// and technique as tests/server-graph-file.test.mjs) must produce exactly
// one terminal partial_success -- not a partial_success *and* a success,
// and not a bare 'cache_hit'/degraded event masquerading as the outcome.
test('file layer: a real pyan3 failure completes as exactly one partial_success', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codeflow-telemetry-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceManager = new WorkspaceManager(root);
  await workspaceManager.ensureRoot();

  const content = await readFile(join(__dirname, 'fixtures/python-symbols/syntax_error.py'), 'utf8');
  const blobSha = 'e'.repeat(40);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/\/repos\/[^/]+\/[^/]+$/.test(u)) return jsonResponse({ default_branch: 'main' });
    if (u.includes('/commits/')) return jsonResponse({ sha: SHA });
    if (u.includes('/git/trees/')) {
      return jsonResponse({ truncated: false, tree: [{ type: 'blob', path: 'broken.py', sha: blobSha, size: content.length }] });
    }
    if (u.includes('/git/blobs/')) {
      return jsonResponse({ encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64') });
    }
    throw new Error('unexpected GitHub URL in test stub: ' + u);
  };
  t.after(() => { globalThis.fetch = original; });

  const cache = new GraphCache({ maxItems: 10, maxBytes: 50_000_000, ttlMs: 60_000, enabled: true });
  const metrics = new Metrics();
  const handler = createGraphFileHandler({
    config: { ...REPO_CONFIG, pythonBin: PYTHON_BIN, pyan3TimeoutMs: 15_000 },
    workspaceManager,
    cache,
    metrics,
  });
  const capture = captureWrites();
  const res = fakeResponse();
  try {
    await handler(fakeRequest({ owner: 'octocat', repo: 'Hello-World', path: 'broken.py' }), res, 'req-partial');
  } finally {
    capture.restore();
  }
  assert.equal(res.statusCode, 200);
  const logLine = terminalLogLine(capture.lines);
  assert.equal(logLine.layer, 'file');
  assert.equal(logLine.resultState, 'partial_success');
  assert.equal(logLine.cacheStatus, 'miss');
  assertOneMatchingTerminalRecord(metrics, logLine);
});
