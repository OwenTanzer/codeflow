// Integration test for MOO-72 Commit 4's file-layer InFlightRegistry
// wiring: two concurrent requests for the same file@revision must share
// one pyan3 run (logged as inflightStatus 'executed' then 'coalesced'),
// both getting a correct, identical graph -- not just the registry's own
// unit tests in tests/inflight-registry.test.mjs, which never touch a real
// route/subprocess.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { GraphCache } from '../server/lib/graph-cache.js';
import { Metrics } from '../server/lib/metrics.js';
import { InFlightRegistry } from '../server/lib/inflight-registry.js';
import { WorkspaceManager } from '../server/lib/workspace.js';
import { createGraphFileHandler } from '../server/routes/graph-file.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHA = 'd'.repeat(40);
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

function fakeRequest(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
}

function fakeResponse() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.body = null;
  res.writableEnded = false;
  res.writeHead = function (status) { this.statusCode = status; };
  res.end = function (payload) { this.body = payload ? JSON.parse(payload) : null; this.writableEnded = true; };
  return res;
}

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

function jsonResponse(body) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) };
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

test('two concurrent requests for the same file@revision coalesce onto one pyan3 run and both get a correct graph', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codeflow-inflight-e2e-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceManager = new WorkspaceManager(root);
  await workspaceManager.ensureRoot();

  const content = await readFile(join(__dirname, 'fixtures/python-symbols/calls.py'), 'utf8');
  const blobSha = 'e'.repeat(40);
  const original = globalThis.fetch;
  let treeFetches = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/\/repos\/[^/]+\/[^/]+$/.test(u)) return jsonResponse({ default_branch: 'main' });
    if (u.includes('/commits/')) return jsonResponse({ sha: SHA });
    if (u.includes('/git/trees/')) {
      treeFetches += 1;
      return jsonResponse({ truncated: false, tree: [{ type: 'blob', path: 'calls.py', sha: blobSha, size: content.length }] });
    }
    if (u.includes('/git/blobs/')) {
      return jsonResponse({ encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64') });
    }
    throw new Error('unexpected GitHub URL in test stub: ' + u);
  };
  t.after(() => { globalThis.fetch = original; });

  const cache = new GraphCache({ maxItems: 10, maxBytes: 50_000_000, ttlMs: 60_000, enabled: true });
  const metrics = new Metrics();
  const inflightRegistry = new InFlightRegistry();
  const handler = createGraphFileHandler({
    config: { ...REPO_CONFIG, pythonBin: PYTHON_BIN, pyan3TimeoutMs: 15_000 },
    workspaceManager,
    cache,
    metrics,
    inflightRegistry,
  });

  const capture = captureWrites();
  const res1 = fakeResponse();
  const res2 = fakeResponse();
  try {
    // Both start before either finishes -- no await between them -- so
    // both reach inflightRegistry.subscribe while the first is still
    // running its real pyan3 subprocess.
    await Promise.all([
      handler(fakeRequest({ owner: 'octocat', repo: 'Hello-World', path: 'calls.py' }), res1, 'req-a'),
      handler(fakeRequest({ owner: 'octocat', repo: 'Hello-World', path: 'calls.py' }), res2, 'req-b'),
    ]);
  } finally {
    capture.restore();
  }

  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.deepEqual(res1.body.graph.nodes, res2.body.graph.nodes);
  assert.deepEqual(res1.body.graph.edges, res2.body.graph.edges);
  assert.ok(res1.body.graph.nodes.length > 0);

  const terminalLines = capture.lines.filter((l) => l.resultState != null && l.layer === 'file');
  assert.equal(terminalLines.length, 2, 'each request still records its own single terminal outcome');
  const inflightStatuses = terminalLines.map((l) => l.inflightStatus).sort();
  assert.deepEqual(inflightStatuses, ['coalesced', 'executed'], 'one request ran the shared pyan3 work, the other joined it');
});

// PR #14 review finding: the in-flight key was the full cacheKey, which
// includes depthMode -- two concurrent requests for the same file@revision
// differing only in requested depth ran two full, duplicate pyan3
// subprocesses instead of sharing one, since chooseDepthMode only runs
// after pyan3 (phase 2, per-caller) and never affects what pyan3 itself is
// asked to do. Proven here by counting actual workspace creations (one per
// real pyan3 run) rather than trusting the log line alone.
test('two concurrent requests for the same file@revision at DIFFERENT depths still share one pyan3 run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codeflow-inflight-depth-e2e-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceManager = new WorkspaceManager(root);
  await workspaceManager.ensureRoot();
  let workspacesCreated = 0;
  const originalCreate = workspaceManager.createRequestWorkspace.bind(workspaceManager);
  workspaceManager.createRequestWorkspace = function (...args) {
    workspacesCreated += 1;
    return originalCreate(...args);
  };

  const content = await readFile(join(__dirname, 'fixtures/python-symbols/calls.py'), 'utf8');
  const blobSha = 'e'.repeat(40);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/\/repos\/[^/]+\/[^/]+$/.test(u)) return jsonResponse({ default_branch: 'main' });
    if (u.includes('/commits/')) return jsonResponse({ sha: SHA });
    if (u.includes('/git/trees/')) {
      return jsonResponse({ truncated: false, tree: [{ type: 'blob', path: 'calls.py', sha: blobSha, size: content.length }] });
    }
    if (u.includes('/git/blobs/')) {
      return jsonResponse({ encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64') });
    }
    throw new Error('unexpected GitHub URL in test stub: ' + u);
  };
  t.after(() => { globalThis.fetch = original; });

  const cache = new GraphCache({ maxItems: 10, maxBytes: 50_000_000, ttlMs: 60_000, enabled: true });
  const metrics = new Metrics();
  const inflightRegistry = new InFlightRegistry();
  const handler = createGraphFileHandler({
    config: { ...REPO_CONFIG, pythonBin: PYTHON_BIN, pyan3TimeoutMs: 15_000 },
    workspaceManager,
    cache,
    metrics,
    inflightRegistry,
  });

  const capture = captureWrites();
  const res1 = fakeResponse();
  const res2 = fakeResponse();
  try {
    await Promise.all([
      handler(fakeRequest({ owner: 'octocat', repo: 'Hello-World', path: 'calls.py', depth: 'symbols' }), res1, 'req-depth-a'),
      handler(fakeRequest({ owner: 'octocat', repo: 'Hello-World', path: 'calls.py', depth: 'full' }), res2, 'req-depth-b'),
    ]);
  } finally {
    capture.restore();
  }

  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.equal(workspacesCreated, 1, 'different depths for the same file@revision must still share one pyan3 run, not one each');

  const terminalLines = capture.lines.filter((l) => l.resultState != null && l.layer === 'file');
  assert.equal(terminalLines.length, 2);
  const inflightStatuses = terminalLines.map((l) => l.inflightStatus).sort();
  assert.deepEqual(inflightStatuses, ['coalesced', 'executed']);
});
