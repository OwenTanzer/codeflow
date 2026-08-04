// Health and readiness endpoints — MOO-67 Commit 5, extended MOO-72
// Commit 5 (dependency/runtime health checks).
//
// /healthz: liveness -- is the process up at all.
// /readyz: readiness -- can it actually serve real requests right now
// (build output present, workspace root writable). Distinguishing the two
// matters once this runs on Railway: a liveness-check failure means
// "restart the container," a readiness-check failure means "stop routing
// traffic here, but don't necessarily restart" (e.g. mid-deploy, or a
// transient filesystem issue).
//
// "gatesReadiness" (not "startup-fatal"): confirmed by reading server/index.js's
// main() that only workspaceRoot is genuinely startup-fatal (a failed
// workspaceManager.ensureRoot() sets exitCode=1 before server.listen() is
// ever called) -- buildOutput, cacheStorage, and nodeRuntime are all only
// ever verified reactively, per-/readyz-request. Naming this category
// "startup-fatal" would overclaim what actually happens; gatesReadiness
// says precisely what's true: these determine the 200/503 status here,
// nothing more.
import { access, constants } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/**
 * Read build-info.json (scripts/generate-build-info.mjs, run as part of
 * `npm run build`) once at startup — MOO-72 Commit 8. Never throws: a
 * missing file (e.g. `node server/index.js` run directly without a prior
 * `npm run build`, as local dev sometimes does) falls back to 'unknown'
 * rather than failing server startup over a provenance nicety.
 * @param {string} repoRoot
 * @returns {{version: string, commitSha: string, dirty: boolean|'unknown'}}
 */
export function readBuildInfo(repoRoot) {
  try {
    const raw = readFileSync(join(repoRoot, 'build-info.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
      commitSha: typeof parsed.commitSha === 'string' ? parsed.commitSha : 'unknown',
      dirty: typeof parsed.dirty === 'boolean' ? parsed.dirty : 'unknown',
    };
  } catch {
    return { version: 'unknown', commitSha: 'unknown', dirty: 'unknown' };
  }
}

/** @param {{config: object, buildInfo: {version: string, commitSha: string, dirty: boolean|'unknown'}}} deps */
export function createHealthHandler({ config, buildInfo }) {
  return async function handleHealth(req, res) {
    sendJson(res, 200, {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      env: config.nodeEnv,
      version: buildInfo.version,
      commitSha: buildInfo.commitSha,
      dirty: buildInfo.dirty,
    });
  };
}

// MOO-72 Commit 5 PR review: must enforce the real declared range
// ("^20.19.0 || >=22.12.0" in package.json), not just a bare major-version
// floor -- a bare `major >= 20` check would wrongly accept 20.0.0, 21.x,
// and 22.0.0, all of which violate that range. Takes a version *string*
// (not reading process.versions.node internally) specifically so boundary
// cases are unit-testable without mutating global state. Deliberately not
// a general semver-range parser -- narrowly matches this project's own
// package.json engines.node shape; if that field's shape changes, this
// must be updated alongside it (a comment at each call site points back
// here).
export function isSupportedNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 20) return minor >= 19;
  if (major === 22) return minor >= 12;
  return major > 22; // 23+ assumed compatible; 21 and bare 22.0-22.11 are not
}

/**
 * MOO-72 Commit 5 PR review: never touches the live, request-serving
 * GraphCache -- GraphCache.set() evicts LRU entries immediately on every
 * call, so a round-trip self-test against the production cache on every
 * /readyz hit would perturb real LRU order, consume capacity, and risk a
 * key collision. `healthCheckCache` must be a separate, dedicated
 * GraphCache instance constructed purely for this self-test (see
 * server/index.js), never touched by any real route.
 * @param {import('./graph-cache.js').GraphCache} healthCheckCache
 * @param {boolean} cacheEnabled
 * @returns {{ok: boolean, detail: string|null}}
 */
function checkCacheStorage(healthCheckCache, cacheEnabled) {
  if (!cacheEnabled) {
    // Disabled by configuration is not "broken" -- report ok, not a failure.
    return { ok: true, detail: 'disabled by configuration (CACHE_ENABLED=false)' };
  }
  const probeKey = '__healthcheck__';
  healthCheckCache.set(probeKey, { probe: true });
  const roundTrip = healthCheckCache.get(probeKey);
  const ok = !!roundTrip && roundTrip.probe === true;
  return { ok, detail: ok ? null : 'isolated cache self-test round-trip failed' };
}

/**
 * Merge in a check's extra detail fields (detail/version/checkedAt) --
 * /readyz has no auth tier to gate this behind (the app has no auth
 * concept at all), so every caller sees the same full detail.
 */
function withDetail(base, extra) {
  return { ...base, ...extra };
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {import('./graph-cache.js').GraphCache} deps.healthCheckCache - a dedicated instance, never the live request-serving cache (see checkCacheStorage)
 * @param {() => {ok: boolean, detail: string|null, version: string|null, checkedAt: string}} [deps.getPyan3Status]
 * @param {() => {ok: boolean, detail: string|null, version: string|null, checkedAt: string}} [deps.getCodeVisualizerStatus]
 * @param {() => {ok: boolean, detail: string|null, version: string|null, checkedAt: string}} [deps.getPythonRuntimeStatus]
 * @param {() => {ok: boolean, detail: string|null, checkedAt: string}} [deps.getGithubReachableStatus]
 * @param {boolean} [deps.pythonTreeSitterCapable] - a static, process-lifetime constant (github-analyzer-bridge.js's PYTHON_TREE_SITTER_CAPABLE), not a getter -- it never changes after import time
 */
export function createReadinessHandler({
  config,
  healthCheckCache,
  getPyan3Status,
  getCodeVisualizerStatus,
  getPythonRuntimeStatus,
  getGithubReachableStatus,
  pythonTreeSitterCapable,
}) {
  return async function handleReadiness(req, res) {
    const checks = {};

    checks.buildOutput = await access(join(config.distDir, 'index.html'), constants.F_OK)
      .then(() => ({ ok: true, gatesReadiness: true }))
      .catch((err) => withDetail({ ok: false, gatesReadiness: true }, { detail: err.code || err.message }));

    checks.workspaceRoot = await access(config.workspaceRoot, constants.W_OK)
      .then(() => ({ ok: true, gatesReadiness: true }))
      .catch((err) => withDetail({ ok: false, gatesReadiness: true }, { detail: err.code || err.message }));

    if (healthCheckCache) {
      const { ok, detail } = checkCacheStorage(healthCheckCache, config.cacheEnabled);
      checks.cacheStorage = withDetail({ ok, gatesReadiness: true }, { detail });
    }

    const nodeOk = isSupportedNodeVersion(process.version);
    checks.nodeRuntime = withDetail(
      { ok: nodeOk, gatesReadiness: true },
      { version: process.version, detail: nodeOk ? null : `Node ${process.version} is outside the range declared in package.json's engines.node` }
    );

    // MOO-70 Commit 9 (PR review): pyan3 unavailability is surfaced here
    // for visibility, but deliberately does NOT gate readiness -- the
    // repository layer and static app have no dependency on pyan3, and
    // /api/graph/file itself already degrades gracefully (tree-sitter-only
    // mode) rather than failing outright. Marking the whole server
    // "not ready" over a file-layer-only capability would take healthy,
    // unrelated functionality out of rotation for no reason.
    if (typeof getPyan3Status === 'function') {
      const status = getPyan3Status();
      checks.pyan3 = withDetail({ ok: status.ok, gatesReadiness: false }, { version: status.version, detail: status.detail, checkedAt: status.checkedAt });
    }

    // MOO-72 Commit 5: separate from pyan3 -- reports the configured
    // interpreter's own version regardless of pyan3's pinned-version
    // specifics, so "Python itself is broken" is distinguishable from
    // "Python works, pyan3 specifically doesn't".
    if (typeof getPythonRuntimeStatus === 'function') {
      const status = getPythonRuntimeStatus();
      checks.pythonRuntime = withDetail({ ok: status.ok, gatesReadiness: false }, { version: status.version, detail: status.detail, checkedAt: status.checkedAt });
    }

    // MOO-71 Commit 5: same non-gating rationale as pyan3 above -- the
    // repository/file layers have no dependency on @codevisualizer/core,
    // so a function-layer-only capability shouldn't take unrelated,
    // healthy functionality out of rotation. MOO-72 Commit 5: startup-only,
    // never refreshed -- the parser-init memoization this depends on lives
    // inside the vendored, commit-pinned @codevisualizer/core package,
    // which this codebase doesn't control or patch just to add live
    // re-verification.
    if (typeof getCodeVisualizerStatus === 'function') {
      const status = getCodeVisualizerStatus();
      checks.codeVisualizer = withDetail({ ok: status.ok, gatesReadiness: false }, { version: status.version, detail: status.detail, checkedAt: status.checkedAt });
    }

    // MOO-72 Commit 5: a second, independent tree-sitter grammar
    // dependency from CodeVisualizer's -- the repository layer's own
    // Python-grammar probe (node-tree-sitter-shim.js's isPythonGrammarCapable(),
    // exported as github-analyzer-bridge.js's PYTHON_TREE_SITTER_CAPABLE),
    // which also affects repository-layer degradation and cache identity.
    // Scoped explicitly to Python -- the only tree-sitter grammar actually
    // used server-side today (JS/JSX discovery goes through Acorn/Babel,
    // not tree-sitter). A static, process-lifetime constant -- never
    // refreshed, since it can't change without a restart anyway.
    if (typeof pythonTreeSitterCapable === 'boolean') {
      checks.pythonTreeSitter = withDetail(
        { ok: pythonTreeSitterCapable, gatesReadiness: false },
        { detail: pythonTreeSitterCapable ? null : 'Python tree-sitter grammar unavailable -- repository analysis falls back to the heuristic (non-AST) call-detection path' }
      );
    }

    // MOO-72 Commit 5: all three layers' GitHub-backed analysis depends on
    // this, but the app shell itself (static serving and health) does
    // not -- same non-gating rationale as pyan3/codeVisualizer, extended
    // to credential/reachability rather than a local binary/build.
    if (typeof getGithubReachableStatus === 'function') {
      const status = getGithubReachableStatus();
      checks.githubReachable = withDetail({ ok: status.ok, gatesReadiness: false }, { detail: status.detail, checkedAt: status.checkedAt });
    }

    // MOO-72 Commit 5: explicit, documented non-check -- pyan3 emits DOT
    // text directly (--dot flag) and it's parsed via the ts-graphviz JS
    // library; no external graphviz/dot binary is ever invoked. `applicable:
    // false`, not `ok: true` -- this never ran a check, and shouldn't read
    // as though it passed one.
    checks.graphvizDot = withDetail(
      { applicable: false, gatesReadiness: false },
      { detail: 'not applicable -- pyan3 emits DOT text directly, parsed via the ts-graphviz JS library; no external graphviz/dot binary is invoked' }
    );

    // MOO-72 Commit 8: operational visibility into the feature flags,
    // distinct from /api/capabilities (the client-facing contract the UI
    // gates its own affordances on) -- this is for an operator checking
    // readiness, not for the frontend.
    checks.featureFlags = withDetail(
      { ok: true, gatesReadiness: false },
      {
        detail: {
          fileLayerEnabled: config.fileLayerEnabled,
          functionLayerEnabled: config.functionLayerEnabled,
          degradedAnalysisEnabled: config.degradedAnalysisEnabled,
          experimentalInteractionsEnabled: config.experimentalInteractionsEnabled,
        },
      }
    );

    const ready = Object.values(checks).every((check) => !check.gatesReadiness || check.ok);
    sendJson(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', checks });
  };
}
