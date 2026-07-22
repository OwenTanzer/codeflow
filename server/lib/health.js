// Health and readiness endpoints — MOO-67 Commit 5.
//
// /healthz: liveness -- is the process up at all.
// /readyz: readiness -- can it actually serve real requests right now
// (build output present, workspace root writable). Distinguishing the two
// matters once this runs on Railway: a liveness-check failure means
// "restart the container," a readiness-check failure means "stop routing
// traffic here, but don't necessarily restart" (e.g. mid-deploy, or a
// transient filesystem issue).
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/** @param {{config: object}} deps */
export function createHealthHandler({ config }) {
  return async function handleHealth(req, res) {
    sendJson(res, 200, {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      env: config.nodeEnv,
    });
  };
}

/**
 * @param {{config: object, getPyan3Available?: () => boolean, getCodeVisualizerAvailable?: () => boolean}} deps
 * `getPyan3Available`/`getCodeVisualizerAvailable` are getters (not
 * plain values) so a later re-check could update them without needing to
 * recreate this handler; optional since not every deployment of this
 * handler needs to report them.
 */
export function createReadinessHandler({ config, getPyan3Available, getCodeVisualizerAvailable }) {
  return async function handleReadiness(req, res) {
    const checks = {};

    checks.buildOutput = await access(join(config.distDir, 'index.html'), constants.F_OK)
      .then(() => ({ ok: true }))
      .catch((err) => ({ ok: false, error: err.code || err.message }));

    checks.workspaceRoot = await access(config.workspaceRoot, constants.W_OK)
      .then(() => ({ ok: true }))
      .catch((err) => ({ ok: false, error: err.code || err.message }));

    // MOO-70 Commit 9 (PR review): pyan3 unavailability is surfaced here
    // for visibility, but deliberately does NOT gate readiness -- the
    // repository layer and static app have no dependency on pyan3, and
    // /api/graph/file itself already degrades gracefully (tree-sitter-only
    // mode) rather than failing outright. Marking the whole server
    // "not ready" over a file-layer-only capability would take healthy,
    // unrelated functionality out of rotation for no reason.
    if (typeof getPyan3Available === 'function') {
      checks.pyan3 = { ok: getPyan3Available(), gatesReadiness: false };
    }

    // MOO-71 Commit 5: same non-gating rationale as pyan3 above -- the
    // repository/file layers have no dependency on @codevisualizer/core,
    // so a function-layer-only capability shouldn't take unrelated,
    // healthy functionality out of rotation.
    if (typeof getCodeVisualizerAvailable === 'function') {
      checks.codeVisualizer = { ok: getCodeVisualizerAvailable(), gatesReadiness: false };
    }

    const ready = ['buildOutput', 'workspaceRoot'].every((key) => checks[key].ok);
    sendJson(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', checks });
  };
}
