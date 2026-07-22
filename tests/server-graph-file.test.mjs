// Unit tests for server/routes/graph-file.js's pure logic (MOO-70 Commit
// 7). The full HTTP handler needs a real GitHub credential to exercise
// end-to-end (same as graph-repository.js) -- this environment has none
// available, so this covers everything testable without network access,
// matching tests/server-graph-repository.test.mjs's own scope exactly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { resolveFileTarget, runPyan3ForFile, enforceFileRequestLimits } from '../server/routes/graph-file.js';
import { validateFileRequest } from '../server/lib/validate-file-request.js';
import { ValidationError } from '../server/lib/validate-repo-request.js';
import { WorkspaceManager } from '../server/lib/workspace.js';
import { stagePythonFiles } from '../server/lib/pyan3Adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures/python-symbols');
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

const TREE_FILES = [
  { path: 'README.md' },
  { path: 'src/app.py' },
  { path: 'src/pkg/__init__.py' },
  { path: 'src/pkg/mod_a.py' },
  { path: 'src/pkg/mod_b.py' },
  { path: 'src/pkg/data.json' },
  { path: 'empty_pkg/notes.txt' },
];

test('resolveFileTarget: an exact .py blob match resolves to file mode', () => {
  const target = resolveFileTarget({ treeFiles: TREE_FILES, requestedPath: 'src/app.py' });
  assert.equal(target.mode, 'file');
  assert.deepEqual(target.targetFiles, [{ path: 'src/app.py' }]);
});

test('resolveFileTarget: a directory prefix with .py files resolves to package mode', () => {
  const target = resolveFileTarget({ treeFiles: TREE_FILES, requestedPath: 'src/pkg' });
  assert.equal(target.mode, 'package');
  const paths = target.targetFiles.map((f) => f.path).sort();
  assert.deepEqual(paths, ['src/pkg/__init__.py', 'src/pkg/mod_a.py', 'src/pkg/mod_b.py']);
});

test('resolveFileTarget: an exact match on a non-.py file throws a clear scope message', () => {
  assert.throws(
    () => resolveFileTarget({ treeFiles: TREE_FILES, requestedPath: 'README.md' }),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /not a Python file/);
      return true;
    }
  );
});

test('resolveFileTarget: a directory with zero .py files throws a clear scope message', () => {
  assert.throws(
    () => resolveFileTarget({ treeFiles: TREE_FILES, requestedPath: 'empty_pkg' }),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /contains no Python/);
      return true;
    }
  );
});

test('resolveFileTarget: a path matching nothing throws "not found"', () => {
  assert.throws(
    () => resolveFileTarget({ treeFiles: TREE_FILES, requestedPath: 'does/not/exist.py' }),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /was not found/);
      return true;
    }
  );
});

test('validateFileRequest: accepts a valid file request shape', () => {
  const request = validateFileRequest({ owner: 'octocat', repo: 'Hello-World', path: 'src/app.py' });
  assert.equal(request.owner, 'octocat');
  assert.equal(request.path, 'src/app.py');
  assert.equal(request.depth, null);
});

test('validateFileRequest: accepts an explicit valid depth override', () => {
  const request = validateFileRequest({ owner: 'octocat', repo: 'Hello-World', path: 'src/pkg', depth: 'methods' });
  assert.equal(request.depth, 'methods');
});

test('validateFileRequest: rejects a missing path', () => {
  assert.throws(() => validateFileRequest({ owner: 'octocat', repo: 'Hello-World' }), ValidationError);
});

test('validateFileRequest: rejects a path with ".." segments', () => {
  assert.throws(
    () => validateFileRequest({ owner: 'octocat', repo: 'Hello-World', path: '../../etc/passwd' }),
    ValidationError
  );
});

test('validateFileRequest: rejects an invalid depth value', () => {
  assert.throws(
    () => validateFileRequest({ owner: 'octocat', repo: 'Hello-World', path: 'src/app.py', depth: 'ultra' }),
    ValidationError
  );
});

// MOO-70 Commit 9: "keep [analysis] operational when pyan3 fails" -- a
// forced pyan3 failure must degrade gracefully (empty relationship set,
// a warning, no thrown error) rather than fail the request. Runs the
// real pinned pyan3 binary against a real broken-syntax fixture (no
// network needed -- pyan3 invocation itself only needs already-staged
// local files) rather than mocking the subprocess.
async function withWorkspace(fn) {
  const root = await mkdtemp(join(tmpdir(), 'codeflow-graph-file-test-'));
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-1');
    await fn(ws);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('runPyan3ForFile: a forced pyan3 failure degrades to an empty relationship set with a warning, never throwing', async () => {
  await withWorkspace(async (ws) => {
    const content = readFileSync(join(FIXTURES, 'syntax_error.py'), 'utf8');
    const [absPath] = await stagePythonFiles(ws, [{ path: 'syntax_error.py', content }]);

    const outcome = await runPyan3ForFile({ pythonBin: PYTHON_BIN, workspace: ws, absolutePaths: [absPath], timeoutMs: 15_000 });

    assert.deepEqual(outcome.pyanNodes, []);
    assert.deepEqual(outcome.pyanEdges, []);
    assert.equal(outcome.failedCategory, 'parser_failure');
    assert.equal(outcome.warnings.length, 1);
    assert.match(outcome.warnings[0], /pyan3 analysis failed \(parser_failure\)/);
  });
});

test('runPyan3ForFile: a clean file returns real nodes/edges with no failure category', async () => {
  await withWorkspace(async (ws) => {
    const content = readFileSync(join(FIXTURES, 'calls.py'), 'utf8');
    const [absPath] = await stagePythonFiles(ws, [{ path: 'calls.py', content }]);

    const outcome = await runPyan3ForFile({ pythonBin: PYTHON_BIN, workspace: ws, absolutePaths: [absPath], timeoutMs: 15_000 });

    assert.equal(outcome.failedCategory, null);
    assert.equal(outcome.warnings.length, 0);
    assert.ok(outcome.pyanNodes.length > 0);
  });
});

// MOO-70 Commit 9 PR review: file count/byte budgets must apply to the
// already-selected target file/package, never to the whole repository --
// a tiny file in a huge monorepo must not be rejected for reasons
// unrelated to what was actually requested.
test('enforceFileRequestLimits: a small target set well under budget passes through unchanged', () => {
  const files = [{ path: 'a.py', size: 100 }, { path: 'b.py', size: 200 }];
  const result = enforceFileRequestLimits(files, { maxRepoFiles: 500, maxFileBytes: 1_000_000, maxRepoBytes: 25_000_000 });
  assert.deepEqual(result, files);
});

test('enforceFileRequestLimits: an individually oversized file is skipped, not a hard failure', () => {
  const files = [{ path: 'a.py', size: 100 }, { path: 'huge.py', size: 10_000 }];
  const result = enforceFileRequestLimits(files, { maxRepoFiles: 500, maxFileBytes: 1_000, maxRepoBytes: 25_000_000 });
  assert.deepEqual(result, [{ path: 'a.py', size: 100 }]);
});

test('enforceFileRequestLimits: throws when the target set\'s aggregate size exceeds the budget', () => {
  const files = [{ path: 'a.py', size: 600 }, { path: 'b.py', size: 600 }];
  assert.throws(
    () => enforceFileRequestLimits(files, { maxRepoFiles: 500, maxFileBytes: 1_000_000, maxRepoBytes: 1_000 }),
    /exceeds the configured aggregate size limit/
  );
});

test('enforceFileRequestLimits: throws when the target set has more files than the configured count limit', () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.py`, size: 10 }));
  assert.throws(
    () => enforceFileRequestLimits(files, { maxRepoFiles: 3, maxFileBytes: 1_000_000, maxRepoBytes: 25_000_000 }),
    /over the configured limit of 3/
  );
});

test('enforceFileRequestLimits: a huge unrelated repository does not affect a tiny requested file (the actual bug reported)', () => {
  // Simulates the reported scenario directly: selectAnalyzableFiles-style
  // whole-repo limits would have rejected this repository outright before
  // ever looking at the one requested file. enforceFileRequestLimits only
  // ever sees the already-selected target set (resolveFileTarget's job),
  // so a repository with thousands of unrelated files never enters into it.
  const target = [{ path: 'tiny.py', size: 42 }];
  const result = enforceFileRequestLimits(target, { maxRepoFiles: 500, maxFileBytes: 1_000_000, maxRepoBytes: 25_000_000 });
  assert.deepEqual(result, target);
});
