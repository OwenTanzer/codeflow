// Periodic dependency/runtime status refresh — MOO-72 Commit 5.
//
// Extracted out of server/index.js specifically so it's directly
// unit-testable: server/index.js runs main() (a real server startup,
// including binding a port) as an import-time side effect, so importing
// anything from it in a test would start a real server just to reach one
// function.
import { recheckPyan3Available, verifyPythonRuntime } from './pyan3Adapter.js';
import { verifyGithubReachable } from './github-analyzer-bridge.js';

/**
 * One normalized shape for every periodically-refreshable dependency's
 * status (PR review finding: pyan3Available/codeVisualizerAvailable were
 * bare booleans, discarding the startup exception's message and the
 * detected version -- readiness detail/version fields need the underlying
 * state to actually carry them).
 * @param {boolean} ok
 * @param {string|null} detail
 * @param {string|null} [version]
 * @returns {{ok: boolean, detail: string|null, version: string|null, checkedAt: string}}
 */
export function makeStatus(ok, detail, version = null) {
  return { ok, detail, version, checkedAt: new Date().toISOString() };
}

/**
 * Re-runs every periodically-refreshable dependency check independently --
 * one failing/rejecting check must never affect another or reject this
 * function as a whole, since a transient GitHub outage shouldn't also blank
 * out the pyan3/Python status. codeVisualizer is deliberately NOT included
 * here -- its parser-init memoization lives inside the vendored,
 * commit-pinned @codevisualizer/core package, which this codebase doesn't
 * control or patch just to add live re-verification (see health.js's own
 * comment on this).
 * @param {object} input
 * @param {string} input.pythonBin
 * @param {string} input.githubToken
 * @returns {Promise<{pyan3Status: object, pythonRuntimeStatus: object, githubReachableStatus: object}>}
 */
export async function refreshDependencyStatuses({ pythonBin, githubToken }) {
  const [pyan3Status, pythonRuntimeStatus, githubReachableStatus] = await Promise.all([
    recheckPyan3Available({ pythonBin })
      .then((version) => makeStatus(true, null, version))
      .catch((err) => makeStatus(false, err && err.message)),
    verifyPythonRuntime({ pythonBin })
      .then((result) => makeStatus(result.ok, result.detail, result.version))
      .catch((err) => makeStatus(false, err && err.message)),
    verifyGithubReachable({ token: githubToken })
      .then((result) => makeStatus(result.ok, result.detail))
      .catch((err) => makeStatus(false, err && err.message)),
  ]);
  return { pyan3Status, pythonRuntimeStatus, githubReachableStatus };
}
