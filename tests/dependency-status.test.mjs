// Unit tests for server/lib/dependency-status.js (MOO-72 Commit 5).
//
// Deliberately does NOT import server/index.js -- that file runs main()
// (a real server startup) as an import-time side effect, which is exactly
// why refreshDependencyStatuses was extracted into its own module: so it
// can be called directly here without starting a real server.
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeStatus, refreshDependencyStatuses } from '../server/lib/dependency-status.js';
import { _resetVerifyCacheForTests } from '../server/lib/pyan3Adapter.js';

const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

test('makeStatus produces the normalized {ok, detail, version, checkedAt} shape', () => {
  const status = makeStatus(true, null, '2.6.2');
  assert.equal(status.ok, true);
  assert.equal(status.detail, null);
  assert.equal(status.version, '2.6.2');
  assert.match(status.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('makeStatus defaults version to null when omitted', () => {
  const status = makeStatus(false, 'boom');
  assert.equal(status.version, null);
});

test('refreshDependencyStatuses: a real interpreter + valid GitHub reachability produce ok statuses', async () => {
  _resetVerifyCacheForTests();
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  try {
    const result = await refreshDependencyStatuses({ pythonBin: PYTHON_BIN, githubToken: 'irrelevant-for-this-mock' });
    assert.equal(result.pyan3Status.ok, true);
    assert.equal(result.pyan3Status.version, '2.6.2');
    assert.equal(result.pythonRuntimeStatus.ok, true);
    assert.match(result.pythonRuntimeStatus.version, /^\d+\.\d+\.\d+$/);
    assert.equal(result.githubReachableStatus.ok, true);
  } finally {
    globalThis.fetch = original;
    _resetVerifyCacheForTests();
  }
});

// Decisive: one failing check must not affect the others, and must not
// reject refreshDependencyStatuses as a whole.
test('refreshDependencyStatuses: a broken pythonBin fails pyan3/pythonRuntime independently, without affecting githubReachable', async () => {
  _resetVerifyCacheForTests();
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  try {
    const result = await refreshDependencyStatuses({ pythonBin: 'definitely-not-a-real-python-binary', githubToken: 'irrelevant' });
    assert.equal(result.pyan3Status.ok, false);
    assert.match(result.pyan3Status.detail, /pyan3 unavailable/);
    assert.equal(result.pythonRuntimeStatus.ok, false);
    assert.match(result.pythonRuntimeStatus.detail, /was not found on PATH/);
    assert.equal(result.githubReachableStatus.ok, true, 'an unrelated GitHub check must not be affected by a broken Python binary');
  } finally {
    globalThis.fetch = original;
    _resetVerifyCacheForTests();
  }
});

test('refreshDependencyStatuses: a GitHub failure does not affect pyan3/pythonRuntime', async () => {
  _resetVerifyCacheForTests();
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  try {
    const result = await refreshDependencyStatuses({ pythonBin: PYTHON_BIN, githubToken: 'bad-token' });
    assert.equal(result.githubReachableStatus.ok, false);
    assert.match(result.githubReachableStatus.detail, /rejected the configured token/);
    assert.equal(result.pyan3Status.ok, true, 'an unrelated pyan3 check must not be affected by a GitHub failure');
    assert.equal(result.pythonRuntimeStatus.ok, true);
  } finally {
    globalThis.fetch = original;
    _resetVerifyCacheForTests();
  }
});
