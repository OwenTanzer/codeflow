// Unit tests for src/state/serverRequest.js's MOO-72 Commit 4 retryability
// normalization: structured route diagnostics aren't the only way a
// request can fail, and each shape (network failure, abort, 429, an
// unstructured 5xx, a structured diagnostic) must map to the right
// retryable value.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ServerRequestError, mapServerJsonResponse, sendServerJsonRequest } from '../src/state/serverRequest.js';

class TestClientError extends ServerRequestError {}

function fakeHeaders(map = {}) {
  return { get: (name) => (name in map ? map[name] : null) };
}

test('mapServerJsonResponse: a structured diagnostic\'s explicit retryable wins over status-based fallback', () => {
  assert.throws(
    () => mapServerJsonResponse(false, 500, { error: 'boom', diagnostics: [{ category: 'internal_error', retryable: false }] }, TestClientError),
    (err) => {
      assert.equal(err.retryable, false);
      return true;
    }
  );
  assert.throws(
    () => mapServerJsonResponse(false, 400, { error: 'boom', diagnostics: [{ category: 'unsupported_input', retryable: true }] }, TestClientError),
    (err) => {
      assert.equal(err.retryable, true);
      return true;
    }
  );
});

test('mapServerJsonResponse: 429 without a structured diagnostic defaults retryable, honoring Retry-After', () => {
  assert.throws(
    () => mapServerJsonResponse(false, 429, { error: 'rate limited' }, TestClientError, fakeHeaders({ 'Retry-After': '30' })),
    (err) => {
      assert.equal(err.retryable, true);
      assert.equal(err.retryAfterMs, 30000);
      return true;
    }
  );
});

test('mapServerJsonResponse: an unstructured 5xx defaults retryable', () => {
  assert.throws(
    () => mapServerJsonResponse(false, 502, null, TestClientError),
    (err) => {
      assert.equal(err.retryable, true);
      return true;
    }
  );
});

test('mapServerJsonResponse: an unstructured 4xx defaults non-retryable', () => {
  assert.throws(
    () => mapServerJsonResponse(false, 403, { error: 'forbidden' }, TestClientError),
    (err) => {
      assert.equal(err.retryable, false);
      return true;
    }
  );
});

test('sendServerJsonRequest: a network failure (fetch rejects) maps to a retryable ServerRequestError', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  try {
    await assert.rejects(
      () => sendServerJsonRequest({ url: '/api/graph/file', init: {}, ErrorClass: TestClientError }),
      (err) => {
        assert.ok(err instanceof TestClientError);
        assert.equal(err.retryable, true);
        assert.equal(err.status, 0);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('sendServerJsonRequest: an AbortError rethrows unchanged, not wrapped as a ServerRequestError', async () => {
  const originalFetch = global.fetch;
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  global.fetch = async () => { throw abortError; };
  try {
    await assert.rejects(
      () => sendServerJsonRequest({ url: '/api/graph/file', init: {}, ErrorClass: TestClientError }),
      (err) => {
        assert.equal(err, abortError);
        assert.ok(!(err instanceof TestClientError));
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('sendServerJsonRequest: a successful response returns the parsed body unchanged', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, headers: fakeHeaders(), json: async () => ({ graph: {} }) });
  try {
    const body = await sendServerJsonRequest({ url: '/api/graph/file', init: {}, ErrorClass: TestClientError });
    assert.deepEqual(body, { graph: {} });
  } finally {
    global.fetch = originalFetch;
  }
});
