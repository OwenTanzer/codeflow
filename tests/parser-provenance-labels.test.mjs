// Unit tests for Parser.extract()'s parser-provenance labeling — MOO-72
// Commit 1A review (round 3).
//
// Confirms two gaps a reviewer found, both now fixed:
//   1. Embedded-script files (HTML/Vue/Svelte) previously returned from
//      extract() without ever setting fns.provenance, silently falling
//      through to the unreliable getParserProvenance() ambient-global
//      guess. Parser.extractJSFunctions() now returns the real label per
//      script block, and extract() aggregates multiple blocks' labels to
//      the single worst-case (most-degraded) one.
//   2. A TypeScript file parsed only after Parser.stripTypeScript() ran
//      (Babel absent or its transform failed) was mislabeled plain
//      'acorn', identical to a file acorn parsed with zero transformation
//      — hiding that a real, less-precise transform happened. It now gets
//      its own label, 'acorn-typescript-strip'.
import assert from 'node:assert/strict';
import test from 'node:test';

if (!('TreeSitter' in globalThis)) globalThis.TreeSitter = undefined;
if (!('Babel' in globalThis)) globalThis.Babel = undefined;
if (typeof globalThis.acorn === 'undefined') {
  const acorn = await import('acorn');
  globalThis.acorn = acorn;
}

const { Parser } = await import('../src/analyzer.js');

test('a plain JS file parsed directly by acorn (no Babel, no TS-strip) is labeled "acorn"', () => {
  const result = Parser.extract('function foo(){return 1;}', 'a.js');
  assert.equal(result.provenance, 'acorn');
});

test('a TS file parsed only after stripTypeScript (Babel absent) is labeled "acorn-typescript-strip", distinct from plain "acorn"', () => {
  const result = Parser.extract('export function foo(x: number): number {\n  return x + 1;\n}\n', 'a.ts');
  assert.equal(result.provenance, 'acorn-typescript-strip');
  assert.ok(result.some((fn) => fn.name === 'foo'), 'the function must still be discovered despite the manual strip');
});

test('an embedded <script> block that acorn parses successfully sets fns.provenance to "acorn", not left unset', () => {
  const html = '<html><body><script>function foo(){return 1;}</script></body></html>';
  const result = Parser.extract(html, 'a.html');
  assert.equal(result.provenance, 'acorn');
});

test('a JS/JSX file whose AST parse fails entirely is labeled "javascript-regex", a TS file "typescript-regex"', () => {
  const brokenJs = Parser.extract('function broken(x { return x }', 'a.js');
  assert.equal(brokenJs.provenance, 'javascript-regex');

  const brokenTs = Parser.extract('function broken(x { return x }', 'a.ts');
  assert.equal(brokenTs.provenance, 'typescript-regex');
});

test('multiple embedded <script> blocks aggregate to the single worst (most-degraded) provenance across the file', () => {
  const html = '<html><body>'
    + '<script>function goodFn(){return 1;}</script>'
    + '<script>function badFn(x { return x }</script>'
    + '</body></html>';
  const result = Parser.extract(html, 'a.html');
  assert.equal(result.provenance, 'javascript-regex', 'one degraded block must taint the whole file\'s aggregate label');
  assert.deepEqual(result.map((fn) => fn.name).sort(), ['badFn', 'goodFn'], 'both blocks\' functions must still be discovered despite the degraded aggregate label');
});
