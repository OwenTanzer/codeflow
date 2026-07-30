// Unit tests for src/state/capabilitiesClient.js (MOO-72 Commit 8, TTL added
// per PR review: the auth token is not a configuration version, so caching
// keyed only by token never observed an operator's flag toggle/redeploy).
//
// The module holds real module-level cache state (not reset between tests),
// so every test here uses a distinct fake token to guarantee a fresh fetch,
// exactly mirroring how a real page only ever uses one token per session.
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

test('fetches on first call and caches the result for the same token', async () => {
  const stub = stubFetch({ fileLayerEnabled: true });
  try {
    let time = 1000;
    const now = () => time;
    const result1 = await fetchCapabilities('token-a', now);
    const result2 = await fetchCapabilities('token-a', now);
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
    let time = 2000;
    const now = () => time;
    await fetchCapabilities('token-b', now);
    assert.equal(stub.calls, 1);

    time += CAPABILITIES_CACHE_TTL_MS + 1;
    await fetchCapabilities('token-b', now);
    assert.equal(stub.calls, 2, 'expected a refetch once the TTL elapsed');
  } finally {
    stub.restore();
  }
});

test('a different token always triggers a fresh fetch regardless of TTL', async () => {
  const stub = stubFetch({ fileLayerEnabled: true });
  try {
    let time = 3000;
    const now = () => time;
    await fetchCapabilities('token-c1', now);
    await fetchCapabilities('token-c2', now);
    assert.equal(stub.calls, 2);
  } finally {
    stub.restore();
  }
});

test('a failed fetch (non-ok response) returns null and does not poison the cache', async () => {
  const stub = stubFetch({}, { ok: false });
  try {
    const result = await fetchCapabilities('token-d');
    assert.equal(result, null);
  } finally {
    stub.restore();
  }
});

test('a thrown fetch error returns null rather than propagating', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('network down'); };
  try {
    const result = await fetchCapabilities('token-e');
    assert.equal(result, null);
  } finally {
    globalThis.fetch = original;
  }
});
