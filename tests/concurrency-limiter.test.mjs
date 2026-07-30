// Unit tests for server/lib/concurrency-limiter.js (MOO-72 Commit 8).
import assert from 'node:assert/strict';
import test from 'node:test';

import { ConcurrencyLimiter, ConcurrencyLimitError, sendCapacityResponse } from '../server/lib/concurrency-limiter.js';
import { InFlightRegistry } from '../server/lib/inflight-registry.js';

test('acquires up to max, then rejects further acquires', () => {
  const limiter = new ConcurrencyLimiter(2);
  const a = limiter.tryAcquire();
  const b = limiter.tryAcquire();
  const c = limiter.tryAcquire();
  assert.equal(a.acquired, true);
  assert.equal(b.acquired, true);
  assert.equal(c.acquired, false);
  assert.equal(limiter.active, 2);
});

test('releasing a slot frees capacity for a subsequent acquire', () => {
  const limiter = new ConcurrencyLimiter(1);
  const a = limiter.tryAcquire();
  assert.equal(a.acquired, true);
  const b = limiter.tryAcquire();
  assert.equal(b.acquired, false);

  a.release();
  assert.equal(limiter.active, 0);
  const c = limiter.tryAcquire();
  assert.equal(c.acquired, true);
});

test('release is idempotent -- calling it twice does not double-free capacity', () => {
  const limiter = new ConcurrencyLimiter(1);
  const a = limiter.tryAcquire();
  a.release();
  a.release();
  assert.equal(limiter.active, 0);
});

test('release works from a finally block after a thrown error, so a failed operation still frees its slot', async () => {
  const limiter = new ConcurrencyLimiter(1);

  async function doWork(shouldThrow) {
    const { acquired, release } = limiter.tryAcquire();
    assert.equal(acquired, true);
    try {
      if (shouldThrow) throw new Error('simulated failure');
    } finally {
      release();
    }
  }

  await assert.rejects(() => doWork(true), /simulated failure/);
  assert.equal(limiter.active, 0);
  const next = limiter.tryAcquire();
  assert.equal(next.acquired, true);
});

// --- sendCapacityResponse ----------------------------------------------

function fakeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
    },
    end(payload) {
      res.body = JSON.parse(payload);
    },
  };
  return res;
}

test('sendCapacityResponse writes a 503 with Retry-After and a matching retryAfterMs body field', () => {
  const res = fakeRes();
  sendCapacityResponse(res, { requestId: 'req-1', sessionId: 'sess-1' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['Retry-After'], '2');
  assert.equal(res.body.retryable, true);
  assert.equal(res.body.retryAfterMs, 2000);
  assert.equal(res.body.requestId, 'req-1');
  assert.equal(res.body.sessionId, 'sess-1');
});

test('sendCapacityResponse defaults sessionId to null when omitted', () => {
  const res = fakeRes();
  sendCapacityResponse(res, { requestId: 'req-1' });
  assert.equal(res.body.sessionId, null);
});

// --- Creator-vs-subscriber composition with InFlightRegistry (mirrors
// graph-file.js's exact pattern: the limiter is acquired only inside the
// shared factory, which InFlightRegistry invokes at most once per key) ---

test('two concurrent subscribers for the same key acquire only one concurrency slot, not two', async () => {
  const limiter = new ConcurrencyLimiter(1);
  const registry = new InFlightRegistry();
  let factoryInvocations = 0;

  function sharedFactory() {
    factoryInvocations += 1;
    const { acquired, release } = limiter.tryAcquire();
    if (!acquired) throw new ConcurrencyLimitError();
    return new Promise((resolve) => setTimeout(resolve, 10, 'shared-result')).finally(release);
  }

  const p1 = registry.subscribe('key-1', sharedFactory, new AbortController().signal);
  const p2 = registry.subscribe('key-1', sharedFactory, new AbortController().signal);

  assert.equal(await p1, 'shared-result');
  assert.equal(await p2, 'shared-result');
  assert.equal(factoryInvocations, 1, 'InFlightRegistry must invoke the factory at most once per shared key');
  assert.equal(limiter.active, 0, 'the single acquired slot must be released once the shared operation settles');
});

test('a concurrency-limit rejection inside the shared factory propagates to every subscriber', async () => {
  const limiter = new ConcurrencyLimiter(1);
  limiter.tryAcquire(); // saturate the only slot from outside this shared operation
  const registry = new InFlightRegistry();

  function sharedFactory() {
    const { acquired } = limiter.tryAcquire();
    if (!acquired) throw new ConcurrencyLimitError();
    return Promise.resolve('unreachable');
  }

  const p1 = registry.subscribe('key-2', sharedFactory, new AbortController().signal);
  const p2 = registry.subscribe('key-2', sharedFactory, new AbortController().signal);

  await assert.rejects(p1, ConcurrencyLimitError);
  await assert.rejects(p2, ConcurrencyLimitError);
});
