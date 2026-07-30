// Client-side fetch wrapper for GET /api/capabilities — MOO-72 Commit 8.
//
// The client-visible half of the server's feature flags (server/index.js):
// the UI fetches this once per committed server token and uses it to hide/
// disable the file/function drill-down affordances when their layer is
// disabled, rather than leaving a still-clickable control that just 503s.
//
// Deliberately tolerant of failure: an unreachable/erroring capabilities
// endpoint must never itself block the app from working -- it falls back to
// null, which every caller treats as "unknown, don't restrict anything"
// rather than "everything disabled".
//
// MOO-72 Commit 8 PR review: the auth token is not a configuration version --
// an operator can toggle these flags and redeploy without ever changing the
// token, so caching keyed only by token meant a long-lived tab could never
// observe a rollout/rollback (most notably: after a layer is re-enabled, a
// page that had cached `false` kept refusing to call it until a full
// reload). A short TTL bounds how stale the cached value can ever be,
// without refetching on every single file/function drill-down request --
// exactly the coarse revalidation this endpoint needs, not a real-time push.
export const CAPABILITIES_CACHE_TTL_MS = 30_000;

let cached = null;
let cachedForToken = null;
let cachedAt = 0;

/**
 * @param {string} serverAuthToken
 * @param {() => number} [now] - injected for testability, defaults to Date.now
 * @returns {Promise<{fileLayerEnabled: boolean, functionLayerEnabled: boolean, degradedAnalysisEnabled: boolean, experimentalInteractionsEnabled: boolean} | null>}
 */
export async function fetchCapabilities(serverAuthToken, now = Date.now) {
  if (cached && cachedForToken === serverAuthToken && now() - cachedAt < CAPABILITIES_CACHE_TTL_MS) {
    return cached;
  }
  try {
    const res = await fetch('/api/capabilities', {
      headers: { Authorization: 'Bearer ' + serverAuthToken },
    });
    if (!res.ok) return null;
    const body = await res.json();
    cached = body;
    cachedForToken = serverAuthToken;
    cachedAt = now();
    return body;
  } catch {
    return null;
  }
}
