// Unit tests for server/routes/graph-file.js's pure logic (MOO-70 Commit
// 7). The full HTTP handler needs a real GitHub credential to exercise
// end-to-end (same as graph-repository.js) -- this environment has none
// available, so this covers everything testable without network access,
// matching tests/server-graph-repository.test.mjs's own scope exactly.
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveFileTarget } from '../server/routes/graph-file.js';
import { validateFileRequest } from '../server/lib/validate-file-request.js';
import { ValidationError } from '../server/lib/validate-repo-request.js';

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
