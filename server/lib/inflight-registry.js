// In-flight subprocess de-duplication — MOO-72 Commit 4.
//
// Two concurrent requests for the same file/package@revision each ran the
// full pyan3 subprocess independently -- GraphCache (server/lib/graph-cache.js)
// only helps *after* the first one finishes. This registry collapses
// concurrent callers sharing a key onto one shared operation.
//
// Subscriber-aware by design, not a plain promise cache: a naive
// `getOrCreate` sharing only the promise breaks Commit 1B's cancellation
// guarantee two ways -- one caller's disconnect would either (a) do
// nothing, orphaning the subprocess once every caller has left, or (b) if
// naively wired to the shared promise, cancel work other callers still
// need. This tracks a live waiter count per shared operation: a caller's
// own abort only detaches *that* caller; the underlying work (and its
// internal AbortController, threaded into execFile's own `signal` option
// by the caller-supplied factory) is only cancelled once the *last* waiter
// leaves, and the entry is evicted immediately so a new caller for the same
// key starts fresh work rather than joining something already dying.
import { RequestCancelledError } from './cancellation.js';

export class InFlightRegistry {
  constructor() {
    this._entries = new Map(); // key -> { promise, controller, waiters }
  }

  /**
   * Whether a shared operation for `key` is already running -- call
   * *before* `subscribe` to distinguish "executed" the work from
   * "coalesced" onto someone else's for observability purposes (see
   * server/routes/graph-file.js's inflightStatus logging).
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this._entries.has(key);
  }

  /**
   * @param {string} key
   * @param {(internalSignal: AbortSignal) => Promise<any>} factory - invoked at most once per shared operation; internalSignal fires only once every waiter has detached
   * @param {AbortSignal} callerSignal - this caller's own per-request cancellation signal
   * @returns {Promise<any>}
   */
  subscribe(key, factory, callerSignal) {
    let entry = this._entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => factory(controller.signal));
      entry = { promise, controller, waiters: 0 };
      this._entries.set(key, entry);
      const evictIfCurrent = () => {
        if (this._entries.get(key) === entry) this._entries.delete(key);
      };
      // Runs on both settlement branches, so a rejected factory can never
      // produce an unhandled rejection here even if every waiter already
      // detached before it settled.
      void promise.then(evictIfCurrent, evictIfCurrent);
    }
    entry.waiters += 1;

    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const onCallerAbort = () => {
        if (settled) return;
        settled = true;
        entry.waiters -= 1;
        callerSignal.removeEventListener('abort', onCallerAbort);
        if (entry.waiters === 0) {
          // Last waiter left: evict immediately (the next caller for this
          // key must never join work that's about to be killed) and cancel
          // the underlying subprocess.
          if (this._entries.get(key) === entry) this._entries.delete(key);
          entry.controller.abort();
        }
        rejectPromise(new RequestCancelledError('client disconnected while awaiting shared analysis'));
      };

      if (callerSignal.aborted) {
        onCallerAbort();
        return;
      }
      callerSignal.addEventListener('abort', onCallerAbort);

      entry.promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          entry.waiters -= 1;
          callerSignal.removeEventListener('abort', onCallerAbort);
          resolvePromise(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          entry.waiters -= 1;
          callerSignal.removeEventListener('abort', onCallerAbort);
          rejectPromise(err);
        }
      );
    });
  }
}
