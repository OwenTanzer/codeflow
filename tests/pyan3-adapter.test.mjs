// Unit tests for server/lib/pyan3Adapter.js (MOO-70 Commit 2).
//
// Runs the real pinned pyan3==2.6.2 binary (no mocked subprocess),
// matching this codebase's existing convention of testing adapters
// against real tools (e.g. tests/repository-graph-adapter.test.mjs runs
// the real analyzer). Needs a working Python 3 interpreter with pyan3
// installed on PATH — CI installs it via actions/setup-python + pip.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { WorkspaceManager } from '../server/lib/workspace.js';
import {
  verifyPyan3Available,
  stagePythonFiles,
  runPyan3,
  isTransientSubprocessFailure,
  _resetVerifyCacheForTests,
} from '../server/lib/pyan3Adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures/python-symbols');
const PACKAGE_FIXTURES = join(__dirname, 'fixtures/python-symbols-package');

// Mirrors server/lib/config.js's PYTHON_BIN default of 'python3', with the
// same env override — this dev machine only has 'python' on PATH, so
// PYTHON_BIN must be set locally the same way it would be in a real
// deployment lacking a `python3` alias.
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

async function withWorkspace(fn) {
  const root = await mkdtemp(join(tmpdir(), 'codeflow-pyan-test-'));
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-1');
    await fn(ws);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('verifyPyan3Available resolves for the pinned version', async () => {
  _resetVerifyCacheForTests();
  await assert.doesNotReject(() => verifyPyan3Available({ pythonBin: PYTHON_BIN }));
});

test('verifyPyan3Available rejects with a clear message when the binary is missing', async () => {
  _resetVerifyCacheForTests();
  await assert.rejects(
    () => verifyPyan3Available({ pythonBin: 'definitely-not-a-real-python-binary' }),
    /pyan3 unavailable/
  );
  _resetVerifyCacheForTests();
});

test('stagePythonFiles writes staged content honoring workspace escape protection', async () => {
  await withWorkspace(async (ws) => {
    const content = readFileSync(join(FIXTURES, 'module_only.py'), 'utf8');
    const [written] = await stagePythonFiles(ws, [{ path: 'module_only.py', content }]);
    assert.equal(written, ws.resolve('module_only.py'));
    await assert.rejects(() => stagePythonFiles(ws, [{ path: '../escape.py', content: 'x = 1' }]), /escapes workspace root/);
  });
});

test('runPyan3: a clean single-file run returns non-empty DOT on stdout', async () => {
  await withWorkspace(async (ws) => {
    const content = readFileSync(join(FIXTURES, 'nested.py'), 'utf8');
    const [absPath] = await stagePythonFiles(ws, [{ path: 'nested.py', content }]);
    const result = await runPyan3({ pythonBin: PYTHON_BIN, workspace: ws, absolutePaths: [absPath], timeoutMs: 15_000 });
    assert.match(result.dot, /digraph/);
    assert.match(result.dot, /Outer/);
    assert.ok(result.durationMs >= 0);
  });
});

test('runPyan3: a clean package run\'s DOT contains nodes for every module', async () => {
  await withWorkspace(async (ws) => {
    const files = readdirSync(PACKAGE_FIXTURES)
      .filter((name) => name.endsWith('.py'))
      .map((name) => ({ path: join('pkg', name), content: readFileSync(join(PACKAGE_FIXTURES, name), 'utf8') }));
    const absolutePaths = await stagePythonFiles(ws, files);
    const result = await runPyan3({ pythonBin: PYTHON_BIN, workspace: ws, absolutePaths, timeoutMs: 15_000 });
    assert.match(result.dot, /mod_a/);
    assert.match(result.dot, /mod_b/);
    assert.match(result.dot, /Widget/);
  });
});

test('runPyan3: a syntax-error file is categorized parser_failure, not subprocess_failure', async () => {
  await withWorkspace(async (ws) => {
    const content = readFileSync(join(FIXTURES, 'syntax_error.py'), 'utf8');
    const [absPath] = await stagePythonFiles(ws, [{ path: 'syntax_error.py', content }]);
    await assert.rejects(
      () => runPyan3({ pythonBin: PYTHON_BIN, workspace: ws, absolutePaths: [absPath], timeoutMs: 15_000 }),
      (err) => {
        assert.equal(err.category, 'parser_failure');
        return true;
      }
    );
  });
});

// MOO-72 Commit 4: unit-level, no real subprocess needed.
test('isTransientSubprocessFailure: recognized transient signals return true', () => {
  assert.equal(isTransientSubprocessFailure({ code: 'EAGAIN' }), true);
  assert.equal(isTransientSubprocessFailure({ code: 'ENOMEM' }), true);
  assert.equal(isTransientSubprocessFailure({ signal: 'SIGSEGV' }), true);
});

test('isTransientSubprocessFailure: a deterministic failure returns false', () => {
  assert.equal(isTransientSubprocessFailure({ code: 'ENOENT' }), false);
  assert.equal(isTransientSubprocessFailure({ message: 'exit code 1' }), false);
  assert.equal(isTransientSubprocessFailure(null), false);
});

test('runPyan3: an artificially tiny timeout is categorized timeout', async () => {
  await withWorkspace(async (ws) => {
    const content = readFileSync(join(FIXTURES, 'nested.py'), 'utf8');
    const [absPath] = await stagePythonFiles(ws, [{ path: 'nested.py', content }]);
    await assert.rejects(
      () => runPyan3({ pythonBin: PYTHON_BIN, workspace: ws, absolutePaths: [absPath], timeoutMs: 1 }),
      (err) => {
        assert.equal(err.category, 'timeout');
        return true;
      }
    );
  });
});
