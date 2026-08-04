// Unit tests for src/state/capabilitiesClient.js (MOO-72 Commit 8, TTL added
// per PR review: an operator can toggle flags and redeploy at any time, so
// an unbounded cache never observed that until a full reload).
//
// The module holds real module-level cache state (not reset between tests),
// so each test advances its own fake clock past the TTL before asserting a
// fresh fetch, rather than relying on per-caller cache keys (there is none
// anymore -- the auth-token-keyed cache this module once had was removed
// along with the app's auth gate entirely).
import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchCapabilities, CAPABILITIES_CACHE_TTL_MS } from '../src/state/capabilitiesClient.js';

function stubFetch(body, { ok = true } = {}) {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok, json: async () => body };
  };
  return {
    get calls() { return calls; },
    restore() { globalThis.fetch = original; },
  };
}

test('fetches on first call and caches the result within the TTL', async () => {
  const stub = stubFetch({ fileLayerEnabled: true });
  try {
    let time = 1000;
    const now = () => time;
    const result1 = await fetchCapabilities(now);
    const result2 = await fetchCapabilities(now);
    assert.deepEqual(result1, { fileLayerEnabled: true });
    assert.deepEqual(result2, { fileLayerEnabled: true });
    assert.equal(stub.calls, 1, 'the second call within the TTL must be served from cache');
  } finally {
    stub.restore();
  }
});

test('refetches once the TTL has elapsed, so a toggled flag becomes visible without a reload', async () => {
  const stub = stubFetch({ fileLayerEnabled: true });
  try {
    // Starts well past the previous test's cachedAt+TTL: the module-level
    // cache has no per-caller key anymore (removed along with appPassword),
    // so test isolation now comes from each test's fake clock starting
    // past every prior test's cache window, not from a distinct cache key.
    let time = 100000;
    const now = () => time;
    await fetchCapabilities(now);
    assert.equal(stub.calls, 1);

    time += CAPABILITIES_CACHE_TTL_MS + 1;
    await fetchCapabilities(now);
    assert.equal(stub.calls, 2, 'expected a refetch once the TTL elapsed');
  } finally {
    stub.restore();
  }
});

test('a failed fetch (non-ok response) returns null and does not poison the cache', async () => {
  const stub = stubFetch({}, { ok: false });
  try {
    const result = await fetchCapabilities();
    assert.equal(result, null);
  } finally {
    stub.restore();
  }
});

test('a thrown fetch error returns null rather than propagating', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('network down'); };
  try {
    const result = await fetchCapabilities();
    assert.equal(result, null);
  } finally {
    globalThis.fetch = original;
  }
});
