// Unit tests for server/routes/graph-function.js's pure logic (MOO-71
// Commit 5). Mirrors tests/server-graph-file.test.mjs's own scope
// exactly: pure exported helpers only, no live network -- this
// environment has no real GitHub credential to exercise the full HTTP
// handler end-to-end.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

import { resolveFunctionSymbol } from '../server/routes/graph-function.js';
import { validateFunctionRequest } from '../server/lib/validate-function-request.js';
import { ValidationError } from '../server/lib/validate-repo-request.js';
import { indexPythonSymbols } from '../server/lib/pythonSymbolIndex.js';
import { lineColumnToCodeUnitOffset } from '../src/graph-ir/codeUnitOffset.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures/python-symbols');
const require = createRequire(import.meta.url);

// --- resolveFunctionSymbol ---

const ENTRIES = [
  { symbolPath: ['Outer', 'run'], symbolKind: 'method' },
  { symbolPath: ['Outer', 'Inner', 'run'], symbolKind: 'method' },
  { symbolPath: ['Outer', 'run', 'helper'], symbolKind: 'function' },
  { symbolPath: [], symbolKind: 'module' },
];

test('resolveFunctionSymbol: an exact symbolPath match resolves', () => {
  const result = resolveFunctionSymbol(ENTRIES, ['Outer', 'Inner', 'run']);
  assert.equal(result.outcome, 'matched');
  assert.equal(result.entry.symbolKind, 'method');
});

test('resolveFunctionSymbol: no matching symbolPath is unresolved, not a guess', () => {
  const result = resolveFunctionSymbol(ENTRIES, ['Outer', 'missing']);
  assert.equal(result.outcome, 'unresolved');
});

test('resolveFunctionSymbol: a symbolPath that is only a prefix of a real one does not match', () => {
  const result = resolveFunctionSymbol(ENTRIES, ['Outer']);
  // ['Outer'] alone matches only an entry with exactly that symbolPath;
  // none exists (Outer.run, Outer.Inner.run, Outer.run.helper all have
  // longer paths) -- confirms this is an exact match, not startsWith.
  assert.equal(result.outcome, 'unresolved');
});

test('resolveFunctionSymbol: two entries sharing one symbolPath are rejected as ambiguous, not tie-broken', () => {
  const duplicated = [...ENTRIES, { symbolPath: ['Outer', 'Inner', 'run'], symbolKind: 'method' }];
  const result = resolveFunctionSymbol(duplicated, ['Outer', 'Inner', 'run']);
  assert.equal(result.outcome, 'ambiguous');
  assert.equal(result.count, 2);
});

// --- validateFunctionRequest ---

test('validateFunctionRequest: accepts a valid request shape', () => {
  const request = validateFunctionRequest({ owner: 'octocat', repo: 'Hello-World', path: 'src/app.py', symbolPath: ['Widget', 'run'] });
  assert.equal(request.path, 'src/app.py');
  assert.deepEqual(request.symbolPath, ['Widget', 'run']);
});

test('validateFunctionRequest: rejects a missing symbolPath', () => {
  assert.throws(
    () => validateFunctionRequest({ owner: 'octocat', repo: 'Hello-World', path: 'src/app.py' }),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /symbolPath/);
      return true;
    }
  );
});

test('validateFunctionRequest: rejects an empty symbolPath array', () => {
  assert.throws(
    () => validateFunctionRequest({ owner: 'octocat', repo: 'Hello-World', path: 'src/app.py', symbolPath: [] }),
    ValidationError
  );
});

test('validateFunctionRequest: rejects a symbolPath containing a non-string', () => {
  assert.throws(
    () => validateFunctionRequest({ owner: 'octocat', repo: 'Hello-World', path: 'src/app.py', symbolPath: ['Widget', 42] }),
    ValidationError
  );
});

test('validateFunctionRequest: accepts and normalizes expectedResolvedSha/expectedSourceOwner/expectedSourceRepo', () => {
  const request = validateFunctionRequest({
    owner: 'octocat',
    repo: 'Hello-World',
    pr: 12,
    path: 'src/app.py',
    symbolPath: ['run'],
    expectedResolvedSha: 'ABCDEF1',
    expectedSourceOwner: 'forker',
    expectedSourceRepo: 'Hello-World',
  });
  assert.equal(request.expectedResolvedSha, 'abcdef1');
  assert.equal(request.expectedSourceOwner, 'forker');
});

// --- lineColumnToCodeUnitOffset: real cross-parser verification ---
//
// Formalizes the spike run before writing this commit: independently
// parse the same fixture with @codevisualizer/core's own tree-sitter
// (via the vendored checkout's real filesystem path -- @codevisualizer/
// core's package.json "exports" map deliberately does not expose
// PyAstParser, so this reaches in the same way
// CodeVisualizer-fork's own scripts/snapshot-flowcharts.mjs does) and
// confirm the symbol index's line/column range, converted via
// lineColumnToCodeUnitOffset, produces the exact same byte range
// @codevisualizer/core's own parse reports for that function.
test('lineColumnToCodeUnitOffset matches @codevisualizer/core’s own tree-sitter parse (ASCII fixture)', async () => {
  await verifyAgainstRealParse('nested.py');
});

test('lineColumnToCodeUnitOffset matches @codevisualizer/core’s own tree-sitter parse (multi-byte UTF-8 fixture)', async () => {
  await verifyAgainstRealParse('unicode_docstring.py');
});

async function verifyAgainstRealParse(fixtureName) {
  const fixturePath = join(FIXTURES, fixtureName);
  const content = readFileSync(fixturePath, 'utf8');
  const { entries } = await indexPythonSymbols({ path: fixturePath, content });
  const functionEntries = entries.filter((e) => e.symbolKind === 'function' || e.symbolKind === 'method');
  assert.ok(functionEntries.length > 0, `${fixtureName} should have at least one function/method entry`);

  const { PyAstParser } = require(join(__dirname, '..', '.vendor', 'codevisualizer', 'packages', 'core', 'dist', 'core', 'language-services', 'python', 'PyAstParser.js'));
  const { resolvePythonWasmPath } = await import('@codevisualizer/core');
  const parser = await PyAstParser.create(resolvePythonWasmPath());
  const tree = parser.parser.parse(content);
  const realDefs = tree.rootNode.descendantsOfType('function_definition');

  for (const entry of functionEntries) {
    const computedStart = lineColumnToCodeUnitOffset(content, entry.startLine, entry.startColumn);
    const computedEnd = lineColumnToCodeUnitOffset(content, entry.endLine, entry.endColumn);
    const realNode = realDefs.find((f) => f.startIndex === computedStart && f.endIndex === computedEnd);
    assert.ok(
      realNode,
      `${entry.qualifiedName}: computed range [${computedStart}, ${computedEnd}] did not match any real function_definition range`
    );
  }
}
