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
let cached = null;
let cachedForToken = null;

/**
 * @param {string} serverAuthToken
 * @returns {Promise<{fileLayerEnabled: boolean, functionLayerEnabled: boolean, degradedAnalysisEnabled: boolean, experimentalInteractionsEnabled: boolean} | null>}
 */
export async function fetchCapabilities(serverAuthToken) {
  if (cached && cachedForToken === serverAuthToken) return cached;
  try {
    const res = await fetch('/api/capabilities', {
      headers: { Authorization: 'Bearer ' + serverAuthToken },
    });
    if (!res.ok) return null;
    const body = await res.json();
    cached = body;
    cachedForToken = serverAuthToken;
    return body;
  } catch {
    return null;
  }
}
