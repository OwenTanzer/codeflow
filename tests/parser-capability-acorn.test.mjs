// Differential test for server/lib/github-analyzer-bridge.js's parser
// capability (MOO-72 Commit 1A review, Blocker A).
//
// The bridge stubs TreeSitter and Babel to `undefined` (unchanged, same
// tradeoff `server/lib/analyzer-bridge.js` already made and docs/baseline.md
// already documents) but now loads the real `acorn` npm package instead of
// stubbing it too. This test characterizes exactly what that buys and
// exactly what gap remains, rather than asserting the change "works" in the
// abstract:
//
//   - plain JS/CommonJS: AST-based function discovery now catches
//     constructs a per-line regex fallback provably cannot (see the
//     multi-line arrow-function case below) — a real capability gain.
//   - JSX/TS: acorn alone cannot parse JSX/TS syntax (no Babel to strip it
//     first), so `Parser.extract`'s AST attempt throws internally and it
//     falls back to a regex path — but which regex path depends on whether
//     acorn is present at all (see the JSX test below): full AST-based
//     discovery for JSX/TS remains the documented, unchanged gap.
//
// Toggles `globalThis.acorn` directly between calls (rather than importing
// src/analyzer.js twice under different global setups) since Parser reads
// `acorn` as an ambient global at call time, not at import time — see
// src/analyzer.js's own top-of-file comment on this pattern.
import assert from 'node:assert/strict';
import test from 'node:test';

if (!('TreeSitter' in globalThis)) globalThis.TreeSitter = undefined;
if (!('Babel' in globalThis)) globalThis.Babel = undefined;
if (!('acorn' in globalThis)) globalThis.acorn = undefined;

const { Parser } = await import('../src/analyzer.js');
const acorn = await import('acorn');

// A multi-line arrow-function assignment: `extractWithRegex`'s arrow-with-
// parens pattern (`/(export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/`)
// is matched per physical line (Parser.extractWithRegex calls
// `content.split('\n').forEach(...)`), so it can only ever match when the
// full `(...) =>` shape appears on one line. Spreading the parameter list
// across lines defeats it by construction, independent of any behavior this
// PR changed.
const MULTILINE_ARROW_JS = [
  'export const computeTotal = (',
  '  a,',
  '  b',
  ') => {',
  '  return a + b;',
  '};',
  '',
].join('\n');

test('acorn loaded: multi-line arrow-function param list is found via AST, not missed by the line-based regex fallback', () => {
  globalThis.acorn = undefined;
  const withoutAcorn = Parser.extract(MULTILINE_ARROW_JS, 'compute.js');
  assert.equal(
    withoutAcorn.some((fn) => fn.name === 'computeTotal'),
    false,
    'sanity check: the regex fallback must actually miss this construct, or the comparison proves nothing'
  );

  globalThis.acorn = acorn;
  const withAcorn = Parser.extract(MULTILINE_ARROW_JS, 'compute.js');
  const found = withAcorn.find((fn) => fn.name === 'computeTotal');
  assert.ok(found, 'acorn AST parsing must find the multi-line arrow function the regex fallback misses');
  assert.equal(found.isExported, true);
  assert.equal(found.type, 'arrow');
});

const JSX_SOURCE = [
  'export function Widget(props) {',
  '  return <div className="widget">{props.label}</div>;',
  '}',
  '',
].join('\n');

// MOO-72 Commit 1A review: acorn alone cannot parse JSX syntax (no Babel to
// strip it first), so this is NOT a case where acorn fixes the gap -- but
// the investigation into this test found a real, previously-undocumented
// wrinkle worth pinning down precisely rather than a simplistic
// "identical either way" claim: `Parser.extract`'s branch on
// `typeof acorn!=='undefined'` doesn't just gate AST parsing, it also gates
// *which regex fallback* a JS/JSX file gets routed to. With acorn absent,
// JSX never enters that branch at all and falls through to
// `extractOtherLanguages` -- a generic multi-language bucket that only
// accidentally catches "function name(" via its PHP pattern, with no
// isExported detection. With acorn present, JSX enters the branch, AST
// parsing throws (JSX syntax), and it falls back to the JS-specific
// `extractWithRegex` instead -- which does detect `export`. So loading
// acorn is a real (if incidental) improvement here too, even though full
// AST-based discovery for JSX itself remains the documented gap.
test('acorn present (even though it cannot parse JSX itself) still routes JSX to the JS-specific regex fallback, not the generic multi-language one', () => {
  globalThis.acorn = undefined;
  const withoutAcorn = Parser.extract(JSX_SOURCE, 'widget.jsx');
  const widgetWithoutAcorn = withoutAcorn.find((fn) => fn.name === 'Widget');
  assert.ok(widgetWithoutAcorn, 'the generic fallback must still find the top-level function declaration');
  assert.equal(widgetWithoutAcorn.isExported, undefined, 'sanity check: the generic multi-language fallback does not detect isExported at all');

  globalThis.acorn = acorn;
  const withAcorn = Parser.extract(JSX_SOURCE, 'widget.jsx');
  const widgetWithAcorn = withAcorn.find((fn) => fn.name === 'Widget');
  assert.ok(widgetWithAcorn, 'the JS-specific regex fallback must also find the top-level function declaration');
  assert.equal(widgetWithAcorn.isExported, true, 'the JS-specific regex fallback (reached only because acorn is present) correctly detects export, unlike the generic fallback');
});

test('acorn loaded: plain JS call-edge detection also benefits (Parser.findCalls uses acorn when present)', () => {
  // A call inside a string/comment that would false-positive-match under
  // the unstripped token heuristic (Blocker A's other documented finding)
  // but must NOT be counted once AST-based detection is available.
  const source = [
    'function helper(x) { return x + 1; }',
    '// helper(999) -- just a comment, not a real call',
    'const real = helper(1);',
  ].join('\n');

  globalThis.acorn = undefined;
  const withoutAcornCalls = Parser.findCalls(source, ['helper'], 'calls.js');

  globalThis.acorn = acorn;
  const withAcornCalls = Parser.findCalls(source, ['helper'], 'calls.js');

  assert.equal(withAcornCalls.helper, 1, 'AST-based detection must count only the real call, ignoring the commented-out lookalike');
  assert.ok(withoutAcornCalls.helper >= withAcornCalls.helper, 'the unstripped token heuristic is documented to be at least as prone to false positives as AST-based detection');
});
