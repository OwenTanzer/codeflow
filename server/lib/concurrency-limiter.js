// Server-wide concurrency cap for expensive analysis work — MOO-72 Commit 8.
//
// Neither the rate limiter (server/lib/rate-limit.js, per-minute request
// count) nor the in-flight registry (server/lib/inflight-registry.js,
// de-duplicates concurrent *identical* requests) bound the number of
// distinct concurrent analyses actually running. This is a plain
// counter-based semaphore for that: callers must acquire a slot
// immediately before doing the expensive work (subprocess spawn or
// synchronous tree-sitter parse) and release it in a `finally`, so a
// thrown error or an aborted request still frees the slot.
export class ConcurrencyLimiter {
  /** @param {number} max */
  constructor(max) {
    this.max = max;
    this.active = 0;
  }

  /**
   * @returns {{acquired: true, release: () => void} | {acquired: false}}
   */
  tryAcquire() {
    if (this.active >= this.max) return { acquired: false };
    this.active += 1;
    let released = false;
    return {
      acquired: true,
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
      },
    };
  }
}

// Thrown by a shared-operation factory (see graph-file.js's InFlightRegistry
// usage) when it can't acquire a slot -- distinguishable from any other
// failure so the route can respond 503 instead of a generic error.
export class ConcurrencyLimitError extends Error {
  constructor() {
    super('Server is at capacity, try again shortly');
    this.name = 'ConcurrencyLimitError';
  }
}

// Unlike the rate limiter's fixed window, there's no deterministic "time
// until a slot frees" here -- this is a fixed short estimate, not a
// guarantee, documented as such rather than presented as precise.
const RETRY_AFTER_SECONDS = 2;

/**
 * Shared 503-at-capacity response, used by every analysis route so the
 * shape (and the client's Retry-After/retryAfterMs contract) stays
 * consistent across all five routes.
 * @param {import('node:http').ServerResponse} res
 * @param {{requestId: string, sessionId: string|null}} options
 */
export function sendCapacityResponse(res, { requestId, sessionId }) {
  res.writeHead(503, {
    'Content-Type': 'application/json; charset=utf-8',
    'Retry-After': String(RETRY_AFTER_SECONDS),
  });
  res.end(
    JSON.stringify({
      error: 'Server is at capacity, try again shortly',
      retryable: true,
      retryAfterMs: RETRY_AFTER_SECONDS * 1000,
      requestId,
      sessionId: sessionId ?? null,
    })
  );
}
