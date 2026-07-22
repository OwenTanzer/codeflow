// Unit tests for server/lib/health.js (MOO-67 Commit 5, extended MOO-70
// Commit 9 PR review: pyan3 readiness must be visible but must never gate
// the overall readiness result).
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createReadinessHandler } from '../server/lib/health.js';

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

async function withBuiltRepo(fn) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'codeflow-health-'));
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'codeflow-health-ws-'));
  try {
    await mkdir(join(repoRoot, 'dist'), { recursive: true });
    await writeFile(join(repoRoot, 'dist', 'index.html'), '<html></html>');
    await fn({ distDir: join(repoRoot, 'dist'), workspaceRoot });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

test('readiness is 200 when pyan3 is unavailable, as long as build output and workspace are fine', async () => {
  await withBuiltRepo(async (config) => {
    const handler = createReadinessHandler({ config, getPyan3Available: () => false });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'ready');
    assert.equal(res.body.checks.pyan3.ok, false);
    assert.equal(res.body.checks.pyan3.gatesReadiness, false);
  });
});

test('readiness is 200 when pyan3 is available too', async () => {
  await withBuiltRepo(async (config) => {
    const handler = createReadinessHandler({ config, getPyan3Available: () => true });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.checks.pyan3.ok, true);
  });
});

test('readiness omits the pyan3 check entirely when no getter is supplied', async () => {
  await withBuiltRepo(async (config) => {
    const handler = createReadinessHandler({ config });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.checks.pyan3, undefined);
  });
});

test('readiness is still 503 when the build output is missing, regardless of pyan3 status', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'codeflow-health-missing-'));
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'codeflow-health-ws-'));
  try {
    const handler = createReadinessHandler({ config: { distDir: join(repoRoot, 'dist'), workspaceRoot }, getPyan3Available: () => true });
    const res = fakeRes();
    await handler({}, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.status, 'not_ready');
    assert.equal(res.body.checks.buildOutput.ok, false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
