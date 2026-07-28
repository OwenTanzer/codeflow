// server/lib/metrics.js -- MOO-72 Commit 3.
import assert from 'node:assert/strict';
import test from 'node:test';

import { Metrics } from '../server/lib/metrics.js';

test('record() accumulates count/sum/max per (layer, resultState) bucket', () => {
  const metrics = new Metrics();
  metrics.record({ layer: 'repository', resultState: 'success', durationMs: 100 });
  metrics.record({ layer: 'repository', resultState: 'success', durationMs: 300 });

  const bucket = metrics.snapshot().buckets.find((b) => b.layer === 'repository' && b.resultState === 'success');
  assert.equal(bucket.count, 2);
  assert.equal(bucket.avgDurationMs, 200);
  assert.equal(bucket.maxDurationMs, 300);
});

test('independent (layer, resultState) buckets do not cross-contaminate', () => {
  const metrics = new Metrics();
  metrics.record({ layer: 'repository', resultState: 'success', durationMs: 100 });
  metrics.record({ layer: 'file', resultState: 'success', durationMs: 500 });
  metrics.record({ layer: 'repository', resultState: 'timeout', durationMs: 9000 });

  const buckets = metrics.snapshot().buckets;
  assert.equal(buckets.length, 3);
  const repoSuccess = buckets.find((b) => b.layer === 'repository' && b.resultState === 'success');
  const fileSuccess = buckets.find((b) => b.layer === 'file' && b.resultState === 'success');
  const repoTimeout = buckets.find((b) => b.layer === 'repository' && b.resultState === 'timeout');
  assert.equal(repoSuccess.count, 1);
  assert.equal(repoSuccess.maxDurationMs, 100);
  assert.equal(fileSuccess.count, 1);
  assert.equal(fileSuccess.maxDurationMs, 500);
  assert.equal(repoTimeout.count, 1);
  assert.equal(repoTimeout.maxDurationMs, 9000);
});

test('an invalid layer is dropped rather than creating a stray bucket', () => {
  const metrics = new Metrics();
  metrics.record({ layer: 'reposiotry', resultState: 'success', durationMs: 100 }); // typo
  assert.equal(metrics.snapshot().buckets.length, 0);
});

test('an invalid resultState is dropped rather than creating a stray bucket', () => {
  const metrics = new Metrics();
  metrics.record({ layer: 'repository', resultState: 'succes', durationMs: 100 }); // typo
  assert.equal(metrics.snapshot().buckets.length, 0);
});

test('a nonterminal/unknown resultState (e.g. accidentally recording a component event) is rejected', () => {
  const metrics = new Metrics();
  metrics.record({ layer: 'file', resultState: 'component_degraded', durationMs: 10 });
  assert.equal(metrics.snapshot().buckets.length, 0);
});

test('a negative or non-finite durationMs is dropped', () => {
  const metrics = new Metrics();
  metrics.record({ layer: 'repository', resultState: 'success', durationMs: -5 });
  metrics.record({ layer: 'repository', resultState: 'success', durationMs: NaN });
  metrics.record({ layer: 'repository', resultState: 'success', durationMs: Infinity });
  assert.equal(metrics.snapshot().buckets.length, 0);
});

test('a durationMs of exactly 0 is valid', () => {
  const metrics = new Metrics();
  metrics.record({ layer: 'function', resultState: 'success', durationMs: 0 });
  const bucket = metrics.snapshot().buckets.find((b) => b.layer === 'function' && b.resultState === 'success');
  assert.equal(bucket.count, 1);
  assert.equal(bucket.avgDurationMs, 0);
});

test('cacheStatus is a separate dimension from resultState -- a cached partial_success stays partial_success', () => {
  const metrics = new Metrics();
  metrics.record({ layer: 'repository', resultState: 'partial_success', durationMs: 5, cacheStatus: 'hit' });
  metrics.record({ layer: 'repository', resultState: 'success', durationMs: 5, cacheStatus: 'miss' });

  const buckets = metrics.snapshot().buckets;
  assert.equal(buckets.length, 2);
  const cachedPartial = buckets.find((b) => b.resultState === 'partial_success');
  assert.equal(cachedPartial.cacheStatus, 'hit');
  assert.equal(cachedPartial.count, 1, 'a degraded response served from cache is not silently reclassified as a plain hit');
});

test('an invalid cacheStatus is dropped rather than creating a stray bucket', () => {
  const metrics = new Metrics();
  metrics.record({ layer: 'repository', resultState: 'success', durationMs: 5, cacheStatus: 'HIT' }); // wrong case
  assert.equal(metrics.snapshot().buckets.length, 0);
});

test('omitted cacheStatus (states that never touch the cache) is recorded as null, not a stray bucket', () => {
  const metrics = new Metrics();
  metrics.record({ layer: 'repository', resultState: 'timeout', durationMs: 5 });
  const bucket = metrics.snapshot().buckets.find((b) => b.resultState === 'timeout');
  assert.equal(bucket.cacheStatus, null);
});

test('snapshot() shape includes scope, windowStartedAt, and snapshotAt', () => {
  const metrics = new Metrics();
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.scope, 'process_lifetime');
  assert.equal(typeof snapshot.windowStartedAt, 'string');
  assert.equal(typeof snapshot.snapshotAt, 'string');
  assert.ok(Array.isArray(snapshot.buckets));
});

test('all closed-vocabulary layers and resultStates are individually accepted', () => {
  const metrics = new Metrics();
  const layers = ['repository', 'file', 'function'];
  const resultStates = [
    'success', 'partial_success', 'timeout', 'validation_error',
    'not_allowlisted', 'github_error', 'parser_failure', 'contract_violation',
    'dependency_unavailable', 'internal_error',
  ];
  for (const layer of layers) {
    for (const resultState of resultStates) {
      metrics.record({ layer, resultState, durationMs: 1 });
    }
  }
  assert.equal(metrics.snapshot().buckets.length, layers.length * resultStates.length);
});
