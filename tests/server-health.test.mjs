// Unit tests for server/lib/health.js (MOO-67 Commit 5, extended MOO-70
// Commit 9 PR review: pyan3 readiness must be visible but must never gate
// the overall readiness result; extended again MOO-72 Commit 5: dependency/
// runtime health checks, and authenticated-only detail exposure).
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createReadinessHandler, createHealthHandler, isSupportedNodeVersion, readBuildInfo } from '../server/lib/health.js';
import { GraphCache } from '../server/lib/graph-cache.js';

const APP_PASSWORD = 'test-app-password';

function fakeReq(authorized) {
  return { headers: authorized ? { authorization: `Bearer ${APP_PASSWORD}` } : {} };
}

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    writeHead(status) {
      res.statusCode = status;
    },
    end(payload) {
      res.body = JSON.parse(payload);
    },
  };
  return res;
}

function freshHealthCheckCache() {
  return new GraphCache({ maxItems: 1, maxBytes: 1024, ttlMs: 60_000, enabled: true });
}

async function withBuiltRepo(fn) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'codeflow-health-'));
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'codeflow-health-ws-'));
  try {
    await mkdir(join(repoRoot, 'dist'), { recursive: true });
    await writeFile(join(repoRoot, 'dist', 'index.html'), '<html></html>');
    await fn({ distDir: join(repoRoot, 'dist'), workspaceRoot, appPassword: APP_PASSWORD, cacheEnabled: true });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function fakeStatus(overrides = {}) {
  return { ok: true, detail: null, version: null, checkedAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

test('readiness is 200 when pyan3 is unavailable, as long as build output and workspace are fine', async () => {
  await withBuiltRepo(async (config) => {
    const handler = createReadinessHandler({ config, healthCheckCache: freshHealthCheckCache(), getPyan3Status: () => fakeStatus({ ok: false }) });
    const res = fakeRes();
    await handler(fakeReq(false), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'ready');
    assert.equal(res.body.checks.pyan3.ok, false);
    assert.equal(res.body.checks.pyan3.gatesReadiness, false);
  });
});

test('readiness is 200 when pyan3 is available too', async () => {
  await withBuiltRepo(async (config) => {
    const handler = createReadinessHandler({ config, healthCheckCache: freshHealthCheckCache(), getPyan3Status: () => fakeStatus({ ok: true }) });
    const res = fakeRes();
    await handler(fakeReq(false), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.checks.pyan3.ok, true);
  });
});

test('readiness omits the pyan3 check entirely when no getter is supplied', async () => {
  await withBuiltRepo(async (config) => {
    const handler = createReadinessHandler({ config, healthCheckCache: freshHealthCheckCache() });
    const res = fakeRes();
    await handler(fakeReq(false), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.checks.pyan3, undefined);
  });
});

test('readiness is still 503 when the build output is missing, regardless of pyan3 status', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'codeflow-health-missing-'));
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'codeflow-health-ws-'));
  try {
    const config = { distDir: join(repoRoot, 'dist'), workspaceRoot, appPassword: APP_PASSWORD, cacheEnabled: true };
    const handler = createReadinessHandler({ config, healthCheckCache: freshHealthCheckCache(), getPyan3Status: () => fakeStatus({ ok: true }) });
    const res = fakeRes();
    await handler(fakeReq(false), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.status, 'not_ready');
    assert.equal(res.body.checks.buildOutput.ok, false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

// --- MOO-72 Commit 5: authenticated-detail gating ---------------------------

test('detail/version/checkedAt fields are omitted from an unauthenticated response', async () => {
  await withBuiltRepo(async (config) => {
    const handler = createReadinessHandler({ config, healthCheckCache: freshHealthCheckCache(), getPyan3Status: () => fakeStatus({ ok: false, detail: 'boom', version: '9.9.9' }) });
    const res = fakeRes();
    await handler(fakeReq(false), res);
    assert.equal(res.body.checks.pyan3.detail, undefined);
    assert.equal(res.body.checks.pyan3.version, undefined);
    assert.equal(res.body.checks.nodeRuntime.version, undefined);
  });
});

test('detail/version/checkedAt fields are present in an authenticated response', async () => {
  await withBuiltRepo(async (config) => {
    const handler = createReadinessHandler({ config, healthCheckCache: freshHealthCheckCache(), getPyan3Status: () => fakeStatus({ ok: false, detail: 'boom', version: '9.9.9' }) });
    const res = fakeRes();
    await handler(fakeReq(true), res);
    assert.equal(res.body.checks.pyan3.detail, 'boom');
    assert.equal(res.body.checks.pyan3.version, '9.9.9');
    assert.equal(typeof res.body.checks.nodeRuntime.version, 'string');
  });
});

test('a request with a wrong bearer token is treated as unauthenticated, not a crash', async () => {
  await withBuiltRepo(async (config) => {
    const handler = createReadinessHandler({ config, healthCheckCache: freshHealthCheckCache(), getPyan3Status: () => fakeStatus({ detail: 'x' }) });
    const res = fakeRes();
    await handler({ headers: { authorization: 'Bearer wrong-token' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.checks.pyan3.detail, undefined);
  });
});

// --- MOO-72 Commit 5: cacheStorage ------------------------------------------

test('cacheStorage reports ok+disabled-detail when caching is disabled by configuration, without touching any cache', async () => {
  await withBuiltRepo(async (baseConfig) => {
    const config = { ...baseConfig, cacheEnabled: false };
    const cache = freshHealthCheckCache();
    const handler = createReadinessHandler({ config, healthCheckCache: cache });
    const res = fakeRes();
    await handler(fakeReq(true), res);
    assert.equal(res.body.checks.cacheStorage.ok, true);
    assert.match(res.body.checks.cacheStorage.detail, /disabled by configuration/);
    assert.equal(cache.size, 0, 'a disabled-cache check must never write to the cache, isolated instance or not');
  });
});

test('cacheStorage round-trips against the isolated instance when caching is enabled, and gates readiness', async () => {
  await withBuiltRepo(async (config) => {
    const cache = freshHealthCheckCache();
    const handler = createReadinessHandler({ config, healthCheckCache: cache });
    const res = fakeRes();
    await handler(fakeReq(false), res);
    assert.equal(res.body.checks.cacheStorage.ok, true);
    assert.equal(res.body.checks.cacheStorage.gatesReadiness, true);
  });
});

test('cacheStorage self-test never touches a separate, real (live) GraphCache instance', async () => {
  await withBuiltRepo(async (config) => {
    const liveCache = new GraphCache({ maxItems: 200, maxBytes: 1_000_000, ttlMs: 60_000, enabled: true });
    liveCache.set('graphir:v1:real-entry', { nodes: [], edges: [] });
    const sizeBefore = liveCache.size;
    const totalBytesBefore = liveCache.totalBytes;

    const healthCheckCache = freshHealthCheckCache();
    const handler = createReadinessHandler({ config, healthCheckCache });
    const res = fakeRes();
    await handler(fakeReq(false), res);

    assert.equal(res.body.checks.cacheStorage.ok, true);
    assert.equal(liveCache.size, sizeBefore, 'the live cache must be completely untouched by the health check');
    assert.equal(liveCache.totalBytes, totalBytesBefore);
    assert.notEqual(liveCache.get('graphir:v1:real-entry'), null, 'the real entry must survive the health check unevicted');
  });
});

// --- MOO-72 Commit 5: nodeRuntime / isSupportedNodeVersion ------------------

test('isSupportedNodeVersion enforces the real declared range, not just a bare major floor', () => {
  assert.equal(isSupportedNodeVersion('v20.18.0'), false, '20.18 is below the declared 20.19.0 floor');
  assert.equal(isSupportedNodeVersion('v20.19.0'), true);
  assert.equal(isSupportedNodeVersion('v20.25.3'), true);
  assert.equal(isSupportedNodeVersion('v21.0.0'), false, '21.x is not in the declared range at all');
  assert.equal(isSupportedNodeVersion('v22.0.0'), false, '22.0 is below the declared 22.12.0 floor');
  assert.equal(isSupportedNodeVersion('v22.11.9'), false);
  assert.equal(isSupportedNodeVersion('v22.12.0'), true);
  assert.equal(isSupportedNodeVersion('v23.0.0'), true, 'a future major beyond the declared range is assumed compatible');
  assert.equal(isSupportedNodeVersion('not-a-version'), false);
});

test('nodeRuntime check reflects process.version and gates readiness', async () => {
  await withBuiltRepo(async (config) => {
    const handler = createReadinessHandler({ config, healthCheckCache: freshHealthCheckCache() });
    const res = fakeRes();
    await handler(fakeReq(false), res);
    assert.equal(res.body.checks.nodeRuntime.gatesReadiness, true);
    assert.equal(res.body.checks.nodeRuntime.ok, isSupportedNodeVersion(process.version));
  });
});

// --- MOO-72 Commit 5: pythonRuntime / codeVisualizer / pythonTreeSitter / githubReachable / graphvizDot ---

test('pythonRuntime check is separate from pyan3 and never gates readiness', async () => {
  await withBuiltRepo(async (config) => {
    const handler = createReadinessHandler({
      config,
      healthCheckCache: freshHealthCheckCache(),
      getPyan3Status: () => fakeStatus({ ok: true }),
      getPythonRuntimeStatus: () => fakeStatus({ ok: false, detail: 'python broken' }),
    });
    const res = fakeRes();
    await handler(fakeReq(true), res);
    assert.equal(res.body.checks.pythonRuntime.ok, false);
    assert.equal(res.body.checks.pythonRuntime.gatesReadiness, false);
    assert.equal(res.body.checks.pythonRuntime.detail, 'python broken');
    assert.equal(res.body.status, 'ready', 'a broken Python runtime must not take the whole service out of rotation');
  });
});

test('codeVisualizer check is reported via getCodeVisualizerStatus and never gates readiness', async () => {
  await withBuiltRepo(async (config) => {
    const handler = createReadinessHandler({
      config,
      healthCheckCache: freshHealthCheckCache(),
      getCodeVisualizerStatus: () => fakeStatus({ ok: false, detail: 'grammar missing' }),
    });
    const res = fakeRes();
    await handler(fakeReq(true), res);
    assert.equal(res.body.checks.codeVisualizer.ok, false);
    assert.equal(res.body.checks.codeVisualizer.gatesReadiness, false);
    assert.equal(res.body.status, 'ready');
  });
});

test('pythonTreeSitter reflects the injected static capability flag, never gates readiness', async () => {
  await withBuiltRepo(async (config) => {
    const handler = createReadinessHandler({ config, healthCheckCache: freshHealthCheckCache(), pythonTreeSitterCapable: false });
    const res = fakeRes();
    await handler(fakeReq(true), res);
    assert.equal(res.body.checks.pythonTreeSitter.ok, false);
    assert.equal(res.body.checks.pythonTreeSitter.gatesReadiness, false);
    assert.match(res.body.checks.pythonTreeSitter.detail, /falls back to the heuristic/);
    assert.equal(res.body.status, 'ready');
  });
});

test('pythonTreeSitter is omitted when not a boolean (e.g. undefined)', async () => {
  await withBuiltRepo(async (config) => {
    const handler = createReadinessHandler({ config, healthCheckCache: freshHealthCheckCache() });
    const res = fakeRes();
    await handler(fakeReq(false), res);
    assert.equal(res.body.checks.pythonTreeSitter, undefined);
  });
});

test('githubReachable check is reported via getGithubReachableStatus and never gates readiness', async () => {
  await withBuiltRepo(async (config) => {
    const handler = createReadinessHandler({
      config,
      healthCheckCache: freshHealthCheckCache(),
      getGithubReachableStatus: () => ({ ok: false, detail: 'GitHub rejected the configured token (401 Unauthorized)', checkedAt: '2026-01-01T00:00:00.000Z' }),
    });
    const res = fakeRes();
    await handler(fakeReq(true), res);
    assert.equal(res.body.checks.githubReachable.ok, false);
    assert.equal(res.body.checks.githubReachable.gatesReadiness, false);
    assert.match(res.body.checks.githubReachable.detail, /rejected the configured token/);
    assert.equal(res.body.status, 'ready');
  });
});

test('graphvizDot is always reported as not-applicable rather than a passed check, and never gates readiness', async () => {
  await withBuiltRepo(async (config) => {
    const handler = createReadinessHandler({ config, healthCheckCache: freshHealthCheckCache() });
    const res = fakeRes();
    await handler(fakeReq(false), res);
    assert.equal(res.body.checks.graphvizDot.applicable, false);
    assert.equal(res.body.checks.graphvizDot.ok, undefined, 'must not read as though a check ran and passed');
    assert.equal(res.body.checks.graphvizDot.gatesReadiness, false);
    assert.equal(res.body.status, 'ready');
  });
});

// --- MOO-72 Commit 8: featureFlags check ------------------------------------

test('featureFlags reports the four Commit 8 flags to an authenticated caller, and never gates readiness', async () => {
  await withBuiltRepo(async (baseConfig) => {
    const config = {
      ...baseConfig,
      fileLayerEnabled: false,
      functionLayerEnabled: true,
      degradedAnalysisEnabled: true,
      experimentalInteractionsEnabled: false,
    };
    const handler = createReadinessHandler({ config, healthCheckCache: freshHealthCheckCache() });
    const res = fakeRes();
    await handler(fakeReq(true), res);
    assert.equal(res.body.checks.featureFlags.ok, true);
    assert.equal(res.body.checks.featureFlags.gatesReadiness, false);
    assert.deepEqual(res.body.checks.featureFlags.detail, {
      fileLayerEnabled: false,
      functionLayerEnabled: true,
      degradedAnalysisEnabled: true,
      experimentalInteractionsEnabled: false,
    });
    assert.equal(res.body.status, 'ready', 'a disabled layer is an operator choice, not a readiness failure');
  });
});

test('featureFlags detail is omitted from an unauthenticated response', async () => {
  await withBuiltRepo(async (baseConfig) => {
    const config = { ...baseConfig, fileLayerEnabled: false };
    const handler = createReadinessHandler({ config, healthCheckCache: freshHealthCheckCache() });
    const res = fakeRes();
    await handler(fakeReq(false), res);
    assert.equal(res.body.checks.featureFlags.ok, true);
    assert.equal(res.body.checks.featureFlags.detail, undefined);
  });
});

// --- MOO-72 Commit 8: readBuildInfo / healthz version-provenance fields ------

test('readBuildInfo returns unknown/false-safe defaults when build-info.json does not exist', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'codeflow-buildinfo-missing-'));
  try {
    const info = readBuildInfo(repoRoot);
    assert.equal(info.version, 'unknown');
    assert.equal(info.commitSha, 'unknown');
    assert.equal(info.dirty, 'unknown');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('readBuildInfo reads a real build-info.json written by generate-build-info.mjs', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'codeflow-buildinfo-'));
  try {
    await writeFile(
      join(repoRoot, 'build-info.json'),
      JSON.stringify({ version: '1.2.3', commitSha: 'abc1234', dirty: true, builtAt: '2026-01-01T00:00:00.000Z' })
    );
    const info = readBuildInfo(repoRoot);
    assert.equal(info.version, '1.2.3');
    assert.equal(info.commitSha, 'abc1234');
    assert.equal(info.dirty, true);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('readBuildInfo falls back to unknown fields on malformed JSON rather than throwing', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'codeflow-buildinfo-malformed-'));
  try {
    await writeFile(join(repoRoot, 'build-info.json'), '{not valid json');
    const info = readBuildInfo(repoRoot);
    assert.equal(info.version, 'unknown');
    assert.equal(info.commitSha, 'unknown');
    assert.equal(info.dirty, 'unknown');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('/healthz includes version/commitSha/dirty from the injected buildInfo', async () => {
  const handler = createHealthHandler({
    config: { nodeEnv: 'test' },
    buildInfo: { version: '1.2.3', commitSha: 'abc1234', dirty: false },
  });
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.body.version, '1.2.3');
  assert.equal(res.body.commitSha, 'abc1234');
  assert.equal(res.body.dirty, false);
});
