// Differential test for the Node-native Python tree-sitter shim
// (server/lib/node-tree-sitter-shim.js) — MOO-72 Commit 1A review (round 2,
// Blocker B).
//
// `Parser.findCalls`'s Python branch (src/analyzer.js) prefers a real
// tree-sitter parser (via `Parser.getLoadedTreeSitterParser`) over the
// token-heuristic fallback (`Parser.stripPythonNonCode` +
// `Parser.countCandidateCalls`) whenever one is loaded. This test drives the
// real shim (not a mock) and asserts real CST-based results on cases the
// reviewer specifically asked for: calls inside strings/comments, nested
// scopes, decorators, and attribute calls — plus a for-loop-target case that
// caught a real bug while writing this test (see below).
//
// This is also the test that caught a genuine, pre-existing bug in
// `isPyDefName` (src/analyzer.js): every `p.childForFieldName(...)===node`
// comparison used JS reference equality, but web-tree-sitter allocates a
// fresh wrapper object on every accessor call, so two accesses of the *same*
// underlying node are never `===`-equal (only `.equals()`/`.id` confirm
// identity) — meaning definition names (e.g. `def helper` itself) were
// silently double-counted as calls to `helper`. Fixed alongside this test by
// switching every such comparison to `SyntaxNode#equals`.
import assert from 'node:assert/strict';
import test from 'node:test';

if (!('Babel' in globalThis)) globalThis.Babel = undefined;
if (typeof globalThis.acorn === 'undefined') {
  const acorn = await import('acorn');
  globalThis.acorn = acorn;
}

const { Parser } = await import('../src/analyzer.js');
const { installNodeTreeSitter } = await import('../server/lib/node-tree-sitter-shim.js');

await installNodeTreeSitter(Parser);
await Parser.prepareTreeSitter([{ path: 'a.py' }]);

test('the real tree-sitter parser is actually loaded, not silently falling back', () => {
  assert.ok(Parser.getLoadedTreeSitterParser('a.py'), 'a Python tree-sitter parser must be loaded for these tests to prove anything');
});

test('a call inside a comment is not counted, unlike the unstripped token heuristic would risk', () => {
  const source = [
    'def helper(x):',
    '    return x + 1',
    '',
    '# helper(999) -- just a comment, not a real call',
    'real = helper(1)',
    '',
  ].join('\n');
  const calls = Parser.findCalls(source, ['helper'], 'a.py');
  assert.equal(calls.helper, 1, 'only the real call must be counted; the definition and the commented-out lookalike must not be');
});

test('a call inside a string literal is not counted', () => {
  const source = [
    'def helper(x):',
    '    return x + 1',
    '',
    'message = "please call helper(5) manually"',
    'real = helper(2)',
    '',
  ].join('\n');
  const calls = Parser.findCalls(source, ['helper'], 'a.py');
  assert.equal(calls.helper, 1, 'a string literal containing the call-shaped text must not be counted as a real call');
});

test('nested scopes: a call inside a nested function definition is still counted', () => {
  const source = [
    'def outer():',
    '    def helper():',
    '        return 1',
    '    return helper()',
    '',
  ].join('\n');
  const calls = Parser.findCalls(source, ['helper'], 'a.py');
  assert.equal(calls.helper, 1, 'the definition itself must be excluded but the real nested-scope call must be counted');
});

test('decorators do not confuse call detection', () => {
  const source = [
    '@some_decorator',
    'def helper():',
    '    pass',
    '',
    'helper()',
    '',
  ].join('\n');
  const calls = Parser.findCalls(source, ['helper'], 'a.py');
  assert.equal(calls.helper, 1, 'a decorated definition must still be excluded from its own call count, and the real call after it counted');
});

test('attribute calls (obj.helper()) are counted, matching this codebase\'s existing call-detection semantics', () => {
  const source = [
    'class Foo:',
    '    def helper(self):',
    '        pass',
    '',
    'f = Foo()',
    'f.helper()',
    '',
  ].join('\n');
  const calls = Parser.findCalls(source, ['helper'], 'a.py');
  assert.equal(calls.helper, 1, 'an attribute-access call to a matching method name is counted, consistent with the token-heuristic fallback\'s own inclusiveness');
});

// MOO-72 Commit 1A review (round 2): the exact regression that caught the
// `isPyDefName` reference-equality bug -- a for-loop target reusing the
// function's own name must not itself be miscounted as a use, and the
// function's own (here: unused) definition must not be counted either.
test('a for-loop target reusing the function name is excluded as a definition, not counted as a use', () => {
  const source = [
    'def helper():',
    '    pass',
    '',
    'for helper in range(3):',
    '    pass',
    '',
  ].join('\n');
  const calls = Parser.findCalls(source, ['helper'], 'a.py');
  assert.equal(calls.helper, 0, 'neither the function definition nor the loop-target binding is a real call');
});

test('real tree-sitter and the token-heuristic fallback agree on a plain, unambiguous call', () => {
  const source = 'def helper(x):\n    return x + 1\n\nreal = helper(1)\n';

  const realParser = Parser.getLoadedTreeSitterParser('a.py');
  const withTreeSitter = Parser.findCalls(source, ['helper'], 'a.py');

  const cleanContent = Parser.stripPythonNonCode(source);
  const withHeuristic = Parser.countCandidateCalls(cleanContent, ['helper'], { isPython: true });

  assert.ok(realParser, 'sanity check: this comparison is only meaningful if tree-sitter is actually loaded');
  assert.equal(withTreeSitter.helper, 1);
  assert.equal(withHeuristic.helper, 1);
});

// MOO-72 Commit 1A review (round 3): `isPyDefName` was missing six binding
// contexts -- confirmed by parsing each construct with the real installed
// grammar (not guessed), each one previously miscounted a rebinding/label as
// a call. Each test below asserts the false-positive case is 0, plus a
// control case proving the harness would catch a real call if one existed.
test('a plain assignment target is not counted as a call to the function it rebinds', () => {
  const source = 'def helper():\n    pass\n\nhelper = None\n';
  assert.equal(Parser.findCalls(source, ['helper'], 'a.py').helper, 0);
});

test('an augmented assignment target is not counted as a call', () => {
  const source = 'def helper():\n    pass\n\nhelper += 1\n';
  assert.equal(Parser.findCalls(source, ['helper'], 'a.py').helper, 0);
});

test('destructuring assignment targets are not counted as calls', () => {
  const source = 'def helper():\n    pass\ndef other():\n    pass\n\nhelper, other = 1, 2\n';
  const calls = Parser.findCalls(source, ['helper', 'other'], 'a.py');
  assert.equal(calls.helper, 0);
  assert.equal(calls.other, 0);
});

test('a walrus-operator (named expression) target is not counted as a call', () => {
  const source = 'def helper():\n    return 1\n\nif (helper := compute()):\n    pass\n';
  assert.equal(Parser.findCalls(source, ['helper'], 'a.py').helper, 0);
});

test('a keyword-argument label is not counted as a call to a function with the same name', () => {
  const source = 'def name():\n    pass\n\nfoo(name=5)\n';
  assert.equal(Parser.findCalls(source, ['name'], 'a.py').name, 0);
});

test('global/nonlocal declarations are not counted as calls', () => {
  const source = [
    'def helper():',
    '    pass',
    '',
    'def f():',
    '    global helper',
    '    helper = 1',
    '',
  ].join('\n');
  assert.equal(Parser.findCalls(source, ['helper'], 'a.py').helper, 0);
});

test('control: a real call still counts 1, proving the six fixes above did not over-exclude', () => {
  const source = 'def helper():\n    pass\n\nhelper()\n';
  assert.equal(Parser.findCalls(source, ['helper'], 'a.py').helper, 1);
});
