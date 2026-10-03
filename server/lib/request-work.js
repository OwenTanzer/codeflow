// Request-local cancellation and accounting for server-side GitHub work.
// A deadline aborts work, then awaits its settlement. Capacity belongs to
// actual work, not to whichever promise wins an HTTP timeout race.
import { AsyncLocalStorage } from 'node:async_hooks';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { RequestCancelledError } from './cancellation.js';

const work = new AsyncLocalStorage();
export class GraphAnalysisTimeoutError extends Error {}
export const currentWork = () => work.getStore();

export function checkpoint() {
  const state = currentWork();
  if (state?.signal.aborted) throw state.signal.reason;
  if (state?.deadline && Date.now() >= state.deadline) {
    state.controller.abort(new GraphAnalysisTimeoutError(state.timeoutMessage));
    throw state.signal.reason;
  }
}
export async function yieldWork() {
  checkpoint();
  await yieldImmediate();
  checkpoint();
}
export async function withTimeout(operation, { timeoutMs, signal, timeoutMessage }) {
  if (typeof operation !== 'function') throw new TypeError('withTimeout requires a work factory');
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason ?? new RequestCancelledError());
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const parent = currentWork();
  const state = {
    ...parent, controller, signal: controller.signal,
    deadline: Math.min(parent?.deadline ?? Infinity, Date.now() + timeoutMs),
    timeoutMessage,
    metrics: parent?.metrics ?? { upstreamRequests: 0 },
  };
  const timer = setTimeout(() => controller.abort(new GraphAnalysisTimeoutError(timeoutMessage)), timeoutMs);
  try {
    return await work.run(state, async () => {
      checkpoint();
      const value = await operation(controller.signal);
      checkpoint();
      return value;
    });
  } catch (err) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Stop sibling workers on first error, propagate abort to active fetch/body
// reads, and drain EVERY worker before rejecting (even a noncooperative mock).
export async function drainingMap(items, concurrency, fn) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('Invalid retrieval concurrency');
  const parent = currentWork();
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.signal.reason);
  if (parent?.signal.aborted) onAbort();
  else parent?.signal.addEventListener('abort', onAbort, { once: true });
  let next = 0;
  let failure;
  const results = new Array(items.length);
  try {
    await work.run({ ...parent, controller, signal: controller.signal }, async () => {
      await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        try {
          while (next < items.length) {
            checkpoint();
            const i = next++;
            results[i] = await fn(items[i], i);
            checkpoint();
          }
        } catch (err) {
          failure ??= err;
          controller.abort(failure);
          throw err;
        }
      }));
    });
    if (failure) throw failure;
    if (controller.signal.aborted) throw controller.signal.reason;
    return results;
  } finally {
    parent?.signal.removeEventListener('abort', onAbort);
  }
}
