// Unit tests for server/lib/inflight-registry.js (MOO-72 Commit 4).
//
// Deliberately exercises the subscriber-aware behavior a plain
// promise-cache implementation would get wrong: per-caller detachment on
// abort, subprocess cancellation only when the *last* waiter leaves, and
// immediate eviction on full abandonment so a later caller for the same
// key never joins dying work.
import assert from 'node:assert/strict';
import test from 'node:test';

import { InFlightRegistry } from '../server/lib/inflight-registry.js';
import { RequestCancelledError } from '../server/lib/cancellation.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('two concurrent subscribers for the same key invoke the factory once and both resolve to the same result', async () => {
  const registry = new InFlightRegistry();
  let factoryCalls = 0;
  const d = deferred();
  const factory = () => { factoryCalls += 1; return d.promise; };

  const p1 = registry.subscribe('key-1', factory, new AbortController().signal);
  const p2 = registry.subscribe('key-1', factory, new AbortController().signal);

  d.resolve('shared-result');
  assert.equal(await p1, 'shared-result');
  assert.equal(await p2, 'shared-result');
  assert.equal(factoryCalls, 1);
});

test('after settling, the next subscribe call for the same key gets a fresh factory invocation, not a replayed result', async () => {
  const registry = new InFlightRegistry();
  let factoryCalls = 0;
  const results = ['first', 'second'];
  const factory = () => Promise.resolve(results[factoryCalls++]);

  const first = await registry.subscribe('key-2', factory, new AbortController().signal);
  const second = await registry.subscribe('key-2', factory, new AbortController().signal);
  assert.equal(factoryCalls, 2);
  assert.equal(first, 'first');
  assert.equal(second, 'second');
});

test('one waiter aborting while a second waiter is still subscribed: the second still resolves normally and the internal signal is never aborted', async () => {
  const registry = new InFlightRegistry();
  const d = deferred();
  let internalSignal;
  const factory = (signal) => { internalSignal = signal; return d.promise; };

  const caller1 = new AbortController();
  const caller2 = new AbortController();
  const p1 = registry.subscribe('key-3', factory, caller1.signal);
  const p2 = registry.subscribe('key-3', factory, caller2.signal);

  caller1.abort();
  await assert.rejects(p1, RequestCancelledError);
  assert.equal(internalSignal.aborted, false, 'a lone caller aborting must not cancel work a second caller still needs');

  d.resolve('still-running');
  assert.equal(await p2, 'still-running');
});

test('all waiters abort: the shared entry is evicted and the internal signal actually fires (subprocess killed)', async () => {
  const registry = new InFlightRegistry();
  const d = deferred();
  let internalSignal;
  const factory = (signal) => { internalSignal = signal; return d.promise; };

  const caller1 = new AbortController();
  const caller2 = new AbortController();
  const p1 = registry.subscribe('key-4', factory, caller1.signal);
  const p2 = registry.subscribe('key-4', factory, caller2.signal);

  caller1.abort();
  await assert.rejects(p1, RequestCancelledError);
  assert.equal(internalSignal.aborted, false, 'still one waiter left');

  caller2.abort();
  await assert.rejects(p2, RequestCancelledError);
  assert.equal(internalSignal.aborted, true, 'last waiter left -- the underlying work must be cancelled');

  // Never leave the abandoned factory promise unresolved forever in the
  // test process -- settle it so nothing lingers.
  d.reject(new Error('killed'));
});

test('a caller arriving after full abandonment gets a fresh factory invocation, not the abandoned one', async () => {
  const registry = new InFlightRegistry();
  const d1 = deferred();
  let factoryCalls = 0;
  const factory = () => {
    factoryCalls += 1;
    return factoryCalls === 1 ? d1.promise : Promise.resolve('fresh-result');
  };

  const caller1 = new AbortController();
  const p1 = registry.subscribe('key-5', factory, caller1.signal);
  caller1.abort();
  await assert.rejects(p1, RequestCancelledError);
  assert.equal(factoryCalls, 1);

  const p2 = registry.subscribe('key-5', factory, new AbortController().signal);
  assert.equal(await p2, 'fresh-result');
  assert.equal(factoryCalls, 2, 'a new caller for an abandoned key must start fresh work, not join the dying one');

  d1.reject(new Error('abandoned'));
});

test('has() reports whether a shared operation for a key is currently running', async () => {
  const registry = new InFlightRegistry();
  const d = deferred();
  assert.equal(registry.has('key-has'), false);
  const p = registry.subscribe('key-has', () => d.promise, new AbortController().signal);
  assert.equal(registry.has('key-has'), true);
  d.resolve('done');
  await p;
  assert.equal(registry.has('key-has'), false, 'evicted once settled');
});

test('a synchronously-throwing factory rejects the caller without producing an unhandled rejection', async () => {
  const registry = new InFlightRegistry();
  const factory = () => { throw new Error('sync boom'); };
  await assert.rejects(
    () => registry.subscribe('key-6', factory, new AbortController().signal),
    /sync boom/
  );
});

test('a factory that rejects is not replayed to a later caller for the same key -- and produces no unhandled rejection', async () => {
  const registry = new InFlightRegistry();
  let factoryCalls = 0;
  const factory = () => {
    factoryCalls += 1;
    return factoryCalls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('recovered');
  };

  await assert.rejects(() => registry.subscribe('key-7', factory, new AbortController().signal), /boom/);
  // Give the registry's own cleanup .then() a turn to run before the next subscribe.
  await new Promise((r) => setImmediate(r));
  const result = await registry.subscribe('key-7', factory, new AbortController().signal);
  assert.equal(result, 'recovered');
  assert.equal(factoryCalls, 2);
});
