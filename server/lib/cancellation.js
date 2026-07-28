// Request cancellation primitives — MOO-72 Commit 1B.
//
// Three distinct primitives for three distinct kinds of work, not one
// mechanism reused everywhere: withTimeout (server/routes/graph-repository.js)
// races a timeout AND this module's abort signal for network phases that
// have no timeout of their own; raceWithAbort here races only the abort
// signal, for work (pyan3) that already owns its own internal timeout and
// must not be raced against a second, competing one; throwIfCancelled is a
// synchronous preflight/checkpoint for work that cannot be interrupted
// mid-flight (CodeVisualizer's CPU-bound parse) or before touching the
// cache/response.

export class RequestCancelledError extends Error {}

/**
 * Detect a client disconnect via the *response*, not the request.
 * req.once('close') fires once the request has finished being consumed,
 * not specifically on disconnect -- a listener attached after the body is
 * read can miss a real disconnect or misclassify a normal completed
 * request depending on timing. res.once('close') combined with
 * `!res.writableEnded` is the correct signal: ServerResponse's 'close'
 * means the response finished OR its connection terminated prematurely,
 * and writableEnded distinguishes the two.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {{signal: AbortSignal, cleanup: () => void}}
 */
export function createRequestAbortSignal(req, res) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort(new RequestCancelledError());
  };
  res.once('close', onClose);
  return {
    signal: controller.signal,
    cleanup() {
      res.off('close', onClose);
    },
  };
}

/**
 * Synchronous preflight/checkpoint -- throws if the client is already
 * gone. Deliberately not a race: some work (CodeVisualizer's parse) is
 * CPU-bound and cannot be interrupted once started, so this can only
 * refuse to start it, or refuse to cache/respond afterward, never observe
 * cancellation *during* it.
 * @param {AbortSignal} signal
 */
export function throwIfCancelled(signal) {
  if (signal.aborted) throw signal.reason ?? new RequestCancelledError();
}

/**
 * Race a promise against only the abort signal, no timer -- for work that
 * already owns its own internal timeout (pyan3's PYAN3_TIMEOUT_MS,
 * degrading internally to a partial result on its own schedule). Wrapping
 * that in a second, separately-timed race would make its outcome
 * timing-dependent between the two competing deadlines; this only lets a
 * client disconnect interrupt the wait, without introducing one.
 * @param {Promise<any>} promise
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
export function raceWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new RequestCancelledError());
  let onAbort;
  const abort = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new RequestCancelledError());
    signal.addEventListener('abort', onAbort);
  });
  return Promise.race([promise, abort]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}
