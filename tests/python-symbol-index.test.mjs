// Unit tests for server/lib/pythonSymbolIndex.js (MOO-70 Commit 1).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { indexPythonSymbols, moduleIdFromPath } from '../server/lib/pythonSymbolIndex.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures/python-symbols');

function loadFixture(name) {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function bySymbolPath(entries, symbolPath) {
  return entries.find((e) => e.symbolPath.join('.') === symbolPath.join('.'));
}

test('moduleIdFromPath: plain module file', () => {
  assert.equal(moduleIdFromPath('pkg/mod.py'), 'pkg.mod');
  assert.equal(moduleIdFromPath('mod.py'), 'mod');
});

test('moduleIdFromPath: __init__.py gets the package name, never an empty string', () => {
  assert.equal(moduleIdFromPath('pkg/__init__.py'), 'pkg');
  assert.equal(moduleIdFromPath('pkg/sub/__init__.py'), 'pkg.sub');
});

test('moduleIdFromPath: root-level __init__.py with no parent package falls back to "__init__"', () => {
  assert.equal(moduleIdFromPath('__init__.py'), '__init__');
});

test('module_only.py: module entry plus one top-level function, module entry has null range', async () => {
  const content = loadFixture('module_only.py');
  const result = await indexPythonSymbols({ path: 'module_only.py', content });

  assert.equal(result.parseErrors, false);
  assert.equal(result.entries.length, 2);

  const moduleEntry = bySymbolPath(result.entries, []);
  assert.equal(moduleEntry.symbolKind, 'module');
  assert.equal(moduleEntry.parentScope, null);
  assert.equal(moduleEntry.startLine, null);
  assert.equal(moduleEntry.startColumn, null);
  assert.equal(moduleEntry.endLine, null);
  assert.equal(moduleEntry.endColumn, null);

  const solo = bySymbolPath(result.entries, ['solo']);
  assert.deepEqual(solo, {
    path: 'module_only.py',
    moduleId: 'module_only',
    qualifiedName: 'module_only.solo',
    shortName: 'solo',
    symbolKind: 'function',
    symbolPath: ['solo'],
    parentScope: 'module_only',
    startLine: 4,
    startColumn: 0,
    endLine: 5,
    endColumn: 12,
    decorators: [],
    isAsync: false,
  });
});

test('nested.py: nested classes/functions get correct kind, scope chain, and exact ranges', async () => {
  const content = loadFixture('nested.py');
  const result = await indexPythonSymbols({ path: 'nested.py', content });

  assert.equal(result.parseErrors, false);

  const outer = bySymbolPath(result.entries, ['Outer']);
  assert.equal(outer.symbolKind, 'class');
  assert.equal(outer.parentScope, 'nested');
  assert.deepEqual([outer.startLine, outer.startColumn, outer.endLine, outer.endColumn], [1, 0, 9, 21]);

  const inner = bySymbolPath(result.entries, ['Outer', 'Inner']);
  assert.equal(inner.symbolKind, 'class');
  assert.equal(inner.parentScope, 'nested.Outer');

  // A def directly inside a class body is a method...
  const innerRun = bySymbolPath(result.entries, ['Outer', 'Inner', 'run']);
  assert.equal(innerRun.symbolKind, 'method');
  assert.equal(innerRun.parentScope, 'nested.Outer.Inner');
  assert.equal(innerRun.qualifiedName, 'nested.Outer.Inner.run');

  const outerRun = bySymbolPath(result.entries, ['Outer', 'run']);
  assert.equal(outerRun.symbolKind, 'method');

  // ...but a def nested inside a function/method body is a nested function,
  // never a method, regardless of how deeply it's nested under a class.
  const helper = bySymbolPath(result.entries, ['Outer', 'run', 'helper']);
  assert.equal(helper.symbolKind, 'function');
  assert.equal(helper.parentScope, 'nested.Outer.run');
  assert.deepEqual([helper.startLine, helper.startColumn, helper.endLine, helper.endColumn], [7, 8, 8, 16]);
});

test('repeated_names.py: same short name in different scopes stays distinguishable via qualifiedName', async () => {
  const content = loadFixture('repeated_names.py');
  const result = await indexPythonSymbols({ path: 'repeated_names.py', content });

  const alphaRun = bySymbolPath(result.entries, ['Alpha', 'run']);
  const betaRun = result.entries.find((e) => e.parentScope === 'repeated_names.Beta' && e.shortName === 'run');

  assert.equal(alphaRun.qualifiedName, 'repeated_names.Alpha.run');
  assert.equal(betaRun.qualifiedName, 'repeated_names.Beta.run');
  assert.notEqual(alphaRun.qualifiedName, betaRun.qualifiedName);
});

test('decorated.py: decorated def range comes from the definition node, not the decorator wrapper; decorator text captured separately', async () => {
  const content = loadFixture('decorated.py');
  const result = await indexPythonSymbols({ path: 'decorated.py', content });

  const widget = bySymbolPath(result.entries, ['Widget']);
  assert.deepEqual(widget.decorators, ['@decorator_one', '@decorator_two("arg")']);
  // The class starts at line 3 ("class Widget:"), not line 1 where its
  // first decorator appears.
  assert.equal(widget.startLine, 3);

  const build = bySymbolPath(result.entries, ['Widget', 'build']);
  assert.deepEqual(build.decorators, ['@staticmethod']);
  assert.equal(build.symbolKind, 'method');
  // The method starts at "def build():", not at its "@staticmethod" line.
  assert.equal(build.startLine, 5);
});

test('async_functions.py: isAsync is set for async methods and async top-level functions', async () => {
  const content = loadFixture('async_functions.py');
  const result = await indexPythonSymbols({ path: 'async_functions.py', content });

  const fetch_ = bySymbolPath(result.entries, ['Service', 'fetch']);
  assert.equal(fetch_.symbolKind, 'method');
  assert.equal(fetch_.isAsync, true);

  const topLevel = bySymbolPath(result.entries, ['top_level']);
  assert.equal(topLevel.symbolKind, 'function');
  assert.equal(topLevel.isAsync, true);

  const service = bySymbolPath(result.entries, ['Service']);
  assert.equal(service.isAsync, false);
});

test('syntax_error.py: broken syntax yields a partial index with parseErrors:true instead of throwing', async () => {
  const content = loadFixture('syntax_error.py');
  const result = await indexPythonSymbols({ path: 'syntax_error.py', content });

  assert.equal(result.parseErrors, true);
  // The well-formed second function is still recovered.
  const solo = bySymbolPath(result.entries, ['solo']);
  assert.equal(solo.symbolKind, 'function');
});

test('determinism: parsing the same source twice yields identical qualifiedNames', async () => {
  const content = loadFixture('nested.py');
  const first = await indexPythonSymbols({ path: 'nested.py', content });
  const second = await indexPythonSymbols({ path: 'nested.py', content });

  assert.deepEqual(
    first.entries.map((e) => e.qualifiedName),
    second.entries.map((e) => e.qualifiedName),
  );
});
