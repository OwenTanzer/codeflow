// Unit tests for server/lib/graph-cache.js — MOO-72 Commit 2.
import assert from 'node:assert/strict';
import test from 'node:test';

import { GraphCache } from '../server/lib/graph-cache.js';

const BIG_TTL = 60 * 60 * 1000;
const BIG_BYTES = 100 * 1024 * 1024;

function makeCache(overrides = {}) {
  return new GraphCache({ maxItems: 3, maxBytes: BIG_BYTES, ttlMs: BIG_TTL, enabled: true, ...overrides });
}

/** A graph-shaped object whose JSON size is predictable. */
function graphOfSize(padLength, id = 'g') {
  return { id, nodes: [], edges: [], warnings: [], pad: 'x'.repeat(padLength) };
}

test('get returns null for a key that was never set', () => {
  const cache = makeCache();
  assert.equal(cache.get('nope'), null);
});

test('set then get returns the exact stored graph', () => {
  const cache = makeCache();
  const graph = graphOfSize(10, 'a');
  cache.set('k', graph);
  assert.equal(cache.get('k'), graph);
  assert.equal(cache.size, 1);
});

test('an entry past its TTL is a miss and is evicted from the map', (t) => {
  const cache = new GraphCache({ maxItems: 3, maxBytes: BIG_BYTES, ttlMs: 1000, enabled: true });
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);

  cache.set('k', graphOfSize(10));
  assert.ok(cache.get('k'), 'still fresh immediately after set');

  now += 1001;
  assert.equal(cache.get('k'), null, 'expired once past the TTL');
  assert.equal(cache.size, 0, 'expired entry is dropped, not left occupying space');
  assert.equal(cache.totalBytes, 0, 'byte accounting is released on expiry');
});

test('an entry exactly at the TTL boundary is still served', (t) => {
  const cache = new GraphCache({ maxItems: 3, maxBytes: BIG_BYTES, ttlMs: 1000, enabled: true });
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);

  cache.set('k', graphOfSize(10));
  now += 1000;
  assert.ok(cache.get('k'), 'expiry is strictly greater-than, so the boundary itself is a hit');
});

test('exceeding maxItems evicts the least recently used entry', () => {
  const cache = makeCache({ maxItems: 3 });
  cache.set('a', graphOfSize(10, 'a'));
  cache.set('b', graphOfSize(10, 'b'));
  cache.set('c', graphOfSize(10, 'c'));
  cache.set('d', graphOfSize(10, 'd'));

  assert.equal(cache.size, 3);
  assert.equal(cache.get('a'), null, 'a was least recently used and got evicted');
  assert.ok(cache.get('b'));
  assert.ok(cache.get('c'));
  assert.ok(cache.get('d'));
});

test('a get refreshes recency, protecting that entry from the next eviction', () => {
  const cache = makeCache({ maxItems: 3 });
  cache.set('a', graphOfSize(10, 'a'));
  cache.set('b', graphOfSize(10, 'b'));
  cache.set('c', graphOfSize(10, 'c'));

  cache.get('a'); // a is now most recently used; b is the LRU
  cache.set('d', graphOfSize(10, 'd'));

  assert.ok(cache.get('a'), 'a survived because reading it refreshed its recency');
  assert.equal(cache.get('b'), null, 'b was evicted instead');
});

test('overwriting an existing key refreshes its LRU position', () => {
  const cache = makeCache({ maxItems: 3 });
  cache.set('a', graphOfSize(10, 'a'));
  cache.set('b', graphOfSize(10, 'b'));
  cache.set('c', graphOfSize(10, 'c'));

  cache.set('a', graphOfSize(10, 'a2')); // overwrite makes a most-recent
  cache.set('d', graphOfSize(10, 'd'));

  assert.equal(cache.get('a').id, 'a2', 'a survived and holds the new value');
  assert.equal(cache.get('b'), null, 'b was the LRU and got evicted');
});

test('overwriting a key does not double-count its bytes', () => {
  const cache = makeCache();
  cache.set('k', graphOfSize(100));
  const afterFirst = cache.totalBytes;
  cache.set('k', graphOfSize(100));
  assert.equal(cache.totalBytes, afterFirst, 'the replaced entry\'s bytes were released');
  assert.equal(cache.size, 1);
});

test('exceeding maxBytes evicts LRU entries until the budget is met', () => {
  const oneEntry = JSON.stringify(graphOfSize(1000, 'a')).length;
  // Room for exactly two entries of this size.
  const cache = new GraphCache({ maxItems: 100, maxBytes: oneEntry * 2 + 10, ttlMs: BIG_TTL, enabled: true });

  cache.set('a', graphOfSize(1000, 'a'));
  cache.set('b', graphOfSize(1000, 'b'));
  assert.equal(cache.size, 2);

  cache.set('c', graphOfSize(1000, 'c'));
  assert.equal(cache.size, 2, 'byte budget forced an eviction well before maxItems');
  assert.equal(cache.get('a'), null, 'the LRU entry went first');
  assert.ok(cache.get('b'));
  assert.ok(cache.get('c'));
  assert.ok(cache.totalBytes <= oneEntry * 2 + 10);
});

test('an entry larger than maxBytes on its own is rejected without flushing the cache', () => {
  const small = graphOfSize(10, 'small');
  const cache = new GraphCache({ maxItems: 100, maxBytes: 500, ttlMs: BIG_TTL, enabled: true });
  cache.set('small', small);

  cache.set('huge', graphOfSize(5000, 'huge'));

  assert.equal(cache.get('huge'), null, 'the oversized entry was not stored');
  assert.ok(cache.get('small'), 'and it did not evict everything else on the way out');
});

test('enabled:false makes get always miss and set a no-op', () => {
  const cache = makeCache({ enabled: false });
  cache.set('k', graphOfSize(10));
  assert.equal(cache.get('k'), null);
  assert.equal(cache.size, 0);
  assert.equal(cache.totalBytes, 0);
});

test('clear empties the cache and resets byte accounting', () => {
  const cache = makeCache();
  cache.set('a', graphOfSize(10, 'a'));
  cache.set('b', graphOfSize(10, 'b'));
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.totalBytes, 0);
  assert.equal(cache.get('a'), null);
});
