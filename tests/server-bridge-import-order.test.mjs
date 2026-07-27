// Regression test for the acorn stub import-order bug — MOO-72 Commit 1A
// review (round 2, Blocker A).
//
// server/index.js imports server/routes/analyze.js (and transitively
// server/lib/analyzer-bridge.js, which stubs `globalThis.acorn = undefined`)
// before it imports the routes that pull in server/lib/github-analyzer-
// bridge.js. A presence-check guard (`if (!('acorn' in globalThis))`) in
// github-analyzer-bridge.js would find the property already exists (even
// though its value is `undefined`) and never assign the real acorn module —
// silently leaving the entire GitHub-backed pipeline on regex/token
// fallbacks despite acorn being installed. This test reproduces the real
// import order from server/index.js (not github-analyzer-bridge.js in
// isolation, which the existing differential test in
// tests/parser-capability-acorn.test.mjs already covers but never exercises
// this ordering) and asserts the real module wins regardless.
import assert from 'node:assert/strict';
import test from 'node:test';

test('importing analyzer-bridge.js before github-analyzer-bridge.js (server/index.js\'s real order) still leaves globalThis.acorn as the real module, not undefined', async () => {
  await import('../server/lib/analyzer-bridge.js');
  assert.equal(typeof globalThis.acorn, 'undefined', 'sanity check: analyzer-bridge.js must actually stub acorn to undefined first, or this test proves nothing');

  await import('../server/lib/github-analyzer-bridge.js');
  assert.notEqual(globalThis.acorn, undefined, 'the real acorn module must win regardless of which bridge module ran first');
  assert.equal(typeof globalThis.acorn.parse, 'function', 'globalThis.acorn must be the real, usable acorn module');
});
