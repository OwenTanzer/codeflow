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

// MOO-72 Commit 8: previously only 429 was read for Retry-After at all --
// the concurrency limiter's 503 was marked retryable but the client
// silently dropped the delay.
test('mapServerJsonResponse: a 503 without a structured diagnostic also honors Retry-After', () => {
  assert.throws(
    () => mapServerJsonResponse(false, 503, { error: 'at capacity', retryable: true }, TestClientError, fakeHeaders({ 'Retry-After': '2' })),
    (err) => {
      assert.equal(err.retryable, true);
      assert.equal(err.retryAfterMs, 2000);
      return true;
    }
  );
});

test('mapServerJsonResponse: a 503 with no Retry-After header falls back to the body\'s own retryAfterMs', () => {
  assert.throws(
    () => mapServerJsonResponse(false, 503, { error: 'at capacity', retryable: true, retryAfterMs: 2000 }, TestClientError, fakeHeaders()),
    (err) => {
      assert.equal(err.retryAfterMs, 2000);
      return true;
    }
  );
});

test('mapServerJsonResponse: a 503 with neither a header nor a body retryAfterMs yields null, not a crash', () => {
  assert.throws(
    () => mapServerJsonResponse(false, 503, { error: 'server error' }, TestClientError, fakeHeaders()),
    (err) => {
      assert.equal(err.retryAfterMs, null);
      assert.equal(err.retryable, true, '5xx still defaults retryable even with no diagnostic');
      return true;
    }
  );
});

// MOO-72 Commit 8 PR review: a disabled-layer 503 (server/index.js) sends
// `{ retryable: false }` at the top level with no structured diagnostic --
// the status-based 5xx default previously overrode that explicit signal.
test('mapServerJsonResponse: an explicit top-level retryable:false on a 503 (disabled layer) is honored, not overridden by the 5xx default', () => {
  assert.throws(
    () => mapServerJsonResponse(false, 503, { error: 'The file layer is currently disabled', retryable: false }, TestClientError, fakeHeaders()),
    (err) => {
      assert.equal(err.retryable, false);
      return true;
    }
  );
});

test('mapServerJsonResponse: an explicit top-level retryable:true on a 503 still works as before', () => {
  assert.throws(
    () => mapServerJsonResponse(false, 503, { error: 'at capacity', retryable: true }, TestClientError, fakeHeaders({ 'Retry-After': '2' })),
    (err) => {
      assert.equal(err.retryable, true);
      assert.equal(err.retryAfterMs, 2000);
      return true;
    }
  );
});

test('mapServerJsonResponse: a diagnostic-level retryable still takes precedence over a top-level one', () => {
  assert.throws(
    () =>
      mapServerJsonResponse(
        false,
        503,
        { error: 'x', retryable: false, diagnostics: [{ category: 'timeout', retryable: true }] },
        TestClientError
      ),
    (err) => {
      assert.equal(err.retryable, true);
      return true;
    }
  );
});

test('mapServerJsonResponse: a 400 never reads Retry-After even if a header happens to be present', () => {
  assert.throws(
    () => mapServerJsonResponse(false, 400, { error: 'bad input' }, TestClientError, fakeHeaders({ 'Retry-After': '99' })),
    (err) => {
      assert.equal(err.retryable, false);
      assert.equal(err.retryAfterMs, null);
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
