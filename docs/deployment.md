# Deployment and operations runbook

MOO-72 Commits 8-9. This is the operational counterpart to `docs/baseline.md`
(a narrative commit-by-commit log) — a task-oriented reference for
deploying, rolling back, and operating this service. It documents the
**current, confirmed-implemented** state, updated as of MOO-72 Commit 9.

**The production cutover described in this file has happened.** CodeViz is
live at `https://codeviz.moopertonic.net` (custom domain, valid TLS
certificate) — see "Cutover runbook" below for the as-executed record and
the reusable procedure it's based on.

## Local development

```
npm install                     # runs setup:codevisualizer + postinstall (pyan3) automatically
AUTH_TOKEN=dev-secret GITHUB_TOKEN=$(gh auth token) ALLOWED_OWNERS=<your-github-username> npm run build
AUTH_TOKEN=dev-secret GITHUB_TOKEN=$(gh auth token) ALLOWED_OWNERS=<your-github-username> npm start
```

`npm run build` also runs `scripts/generate-build-info.mjs`, which writes
`build-info.json` (gitignored — a build artifact, not source) with the
current `version`/`commitSha`/`dirty` state; `npm start` reads it at
startup and serves it from `/healthz` and the UI's corner badge. Missing
the file (e.g. running `node server/index.js` directly without a prior
build) falls back to `"unknown"` rather than failing startup.

`AUTH_TOKEN`, `GITHUB_TOKEN`, and at least one of `ALLOWED_OWNERS`/
`ALLOWED_REPOS` are required at startup with no bypass — a missing
`NODE_ENV=production` can't silently ship an unprotected instance. See
`server/lib/config.js` for the full set of environment variables and their
defaults.

## Feature flags (MOO-72 Commit 8)

Each defaults to today's always-on behavior — an existing deployment's
behavior does not change unless an operator explicitly sets one of these:

| Env var | Default | Effect when set to `false` |
|---|---|---|
| `FILE_LAYER_ENABLED` | `true` | `/api/graph/file` returns `503 {error, retryable:false}`; the UI's file drill-down panel shows a clear "disabled by the server operator" message (via `GET /api/capabilities`) instead of a raw error. |
| `FUNCTION_LAYER_ENABLED` | `true` | Same, for `/api/graph/function` and the function drill-down panel. |
| `DEGRADED_ANALYSIS_ENABLED` | `true` | Gates `server/routes/graph-file.js`'s pyan3-fails → tree-sitter-only degrade path specifically. When `false`, a pyan3 failure returns a real `502` error instead of silently serving a lower-confidence graph — for an operator who wants to know immediately rather than degrade quietly. The function layer has no analogous fallback to gate (see `graph-function.js`'s own header comment); there is no separate "renderer fallback" flag because no separate renderer-fallback subsystem exists in this codebase. |
| `EXPERIMENTAL_INTERACTIONS_ENABLED` | `false` | Currently gates no behavior — no experimental interaction exists yet in this codebase (confirmed by checking `src/graph-ir/depthPolicy.js` and `server/lib/validate-file-request.js`: `depth` is a fixed enum with nothing past `'full'`). Ships now so the next experimental piece of work has a config knob to attach to from day one, rather than needing its own flag invented later. |

Each is validated strictly (`"true"`/`"false"` only — a typo like `fasle`
fails startup, not silently keeps the default) and surfaced two ways:
- `GET /api/capabilities` (authenticated): the client-facing contract the
  UI reads at startup to hide/disable the corresponding affordance.
- `GET /readyz`'s authenticated detail (`checks.featureFlags.detail`): for
  an operator checking current state directly.

## Resource limits and concurrency

Pre-existing (env-configurable, validated fail-fast at startup — see
`server/lib/config.js` for exact defaults): request body size
(`MAX_REQUEST_BODY_BYTES`), per-request file/byte caps
(`MAX_REPO_FILES`/`MAX_FILE_BYTES`/`MAX_REPO_BYTES`), analysis and pyan3
timeouts (`GRAPH_ANALYSIS_TIMEOUT_MS`/`PYAN3_TIMEOUT_MS`), and per-minute
rate limiting (`RATE_LIMIT_PER_MINUTE`).

New in this commit (`server/lib/concurrency-limiter.js`):

- **`MAX_CONCURRENT_ANALYSES`** (default `4`) — a server-wide cap on
  concurrently *running* expensive analyses (subprocess spawns, synchronous
  tree-sitter parses), shared across all five analysis routes
  (`/api/analyze`, `/api/analyze-repo`, `/api/graph/repository`,
  `/api/graph/file`, `/api/graph/function`). Neither the per-minute rate
  limiter nor the file layer's in-flight de-duplication registry bounded
  this before — a rate-limited caller could still pile up many *distinct*
  concurrent analyses. **The default of 4 is not load-tested** — it's a
  conservative starting point derived from what's actually known
  (tree-sitter parsing is synchronous/CPU-bound and blocks Node's single
  event loop thread while running; Railway's default/hobby-tier containers
  are commonly 1-2 vCPUs), not from real production metrics. Tune it after
  deployment using Railway's own CPU/memory metrics for this service,
  raising it if the container has headroom and requests are being
  needlessly 503'd, or lowering it if the container is struggling under
  load. A request rejected for capacity gets `503` with a real
  `Retry-After` header and a `retryAfterMs` field in the body (a fixed
  short estimate, not a guaranteed window — there's no deterministic "time
  until a slot frees" the way the rate limiter's fixed window has one).
- **`GITHUB_FETCH_CONCURRENCY`** (default `8`) — concurrent GitHub blob
  fetches per request. Previously hardcoded as a default parameter in
  `fetchAllContents` with no override.
- **`PYAN3_MAX_BUFFER_BYTES`** (default `20 * 1024 * 1024`) — pyan3
  subprocess output buffer cap. Previously hardcoded as a default
  parameter in `runPyan3` with no override.

## Version and commit provenance

`scripts/generate-build-info.mjs` (run as part of `npm run build`, before
`vite build`) is the **one shared source** both the server and the UI read
from — `server/index.js` runs directly via `node server/index.js` (see
`package.json`'s `start` script), never processed by Vite, so a
Vite-`define`-only injection would never reach it; this avoids two
independently-computed values that could drift.

- `commitSha`: explicit `BUILD_COMMIT_SHA` env override first (so any
  CI/deployment environment can inject a known-good value without git
  metadata present at all), else Railway's own `RAILWAY_GIT_COMMIT_SHA`
  (provided automatically for builds/deployments from a connected GitHub
  repo — [Railway's variable reference](https://docs.railway.com/variables/reference)
  — but not guaranteed for every build type, e.g. a bare `railway up` from a
  local directory with no git metadata in the uploaded context), else
  `git rev-parse HEAD` (caught — never fails the build over a provenance
  nicety), else the literal string `"unknown"`.
- `dirty`: `true` if `git status --porcelain` reports anything at build
  time, surfaced (not enforced) — **production builds should come from a
  clean CI/Railway checkout**, not a working copy with uncommitted changes;
  this is not a hard build-time gate, so an emergency hotfix build from a
  dirty tree still succeeds, just visibly marked.
- Exposed via `GET /healthz` (`version`/`commitSha`/`dirty` fields, already
  public/unauthenticated) and a small corner badge in the UI that fetches
  from there.

## Dependency pinning

Three distinct categories, not one list — conflating them hides which
upgrades are safe to do casually and which require deliberate re-pinning:

**Exact pins** (reproducible only if bumped deliberately):
- `@codevisualizer/core` — `codevisualizer-core.lock.json` pins commit
  `974d907a5490aa96fb8e84b6723d15bc5455c658` of
  `OwenTanzer/CodeVisualizer`, provisioned by
  `scripts/setup-codevisualizer-core.mjs` (runs as `preinstall`).
- `pyan3==2.6.2` — `requirements.txt`, installed by
  `scripts/install-pyan3.mjs` (runs as `postinstall`) into a repo-local
  venv (`.venv-pyan3/`).
- Python `3.13` — `railpack.json`'s `packages.python`, pinned to prevent
  Railpack's zero-config detection from misclassifying this Node-primary
  app as Python (see `docs/file-layer-limitations.md`'s "Production Python
  dependency" section for the full incident this fixed).
- `package.json` exact versions: `tree-sitter-wasms@0.1.13`,
  `ts-graphviz@3.0.7`, `web-tree-sitter@0.20.8`, `vite@8.1.5`.

**Compatibility ranges — explicitly *not* pins**:
- `acorn@^8.17.0`, `playwright@^1.61.1` (`package.json` `dependencies`/
  `devDependencies`).
- `engines.node: "^20.19.0 || >=22.12.0"` (`package.json`).

**Reproducibility source**: `package-lock.json` is what actually fixes
every transitive dependency's resolved version — `npm ci` honors it
exactly; plain `npm install` may re-resolve within the ranges above and is
not guaranteed to reproduce the same tree. Use `npm ci` for a clean
install (see "Local development" above and the dependency-upgrade
procedures below).

## Cache management

`server/lib/graph-cache.js`'s `GraphCache` (the shared cross-layer graph
cache) has **no runtime or HTTP-exposed way to inspect or invalidate it**
— confirmed: no `/api/admin` or cache-management route exists anywhere in
this codebase. Individual entries age out on their own via TTL
(`CACHE_TTL_MS`, default 1 hour) and LRU eviction once `CACHE_MAX_ITEMS`/
`CACHE_MAX_BYTES` is reached. **The only way to force a full invalidation
today is a process restart or Railway redeploy** — both wipe the
process-local cache entirely, since it is deliberately not durable and not
shared across replicas (single-instance design). This is a real,
documented operational gap, not a silent limitation — if a bad cached
result needs to go away right now, a restart is the only lever, not a
targeted-clear.

## Log operations

`server/lib/logger.js` writes one JSON object per line, `stdout` for
everything except `error` (which goes to `stderr`) — no in-app rotation or
retention logic exists; log retention beyond that is entirely Railway's
own platform behavior, not something this codebase controls.

- **Retrieve logs**: `railway logs` (streams the linked service's live
  logs), or `railway logs --deployment <id>` for a specific past
  deployment, or `railway logs --lines 200`/`--since 1h` for a
  non-streaming pull. (All confirmed working live against the `codeviz`
  service this session.)
- **Useful fields to filter/grep on**: `requestId` (correlates every log
  line for one request), `sessionId` (correlates a repo→file→function
  navigation session — see `src/state/analysisSession.js`), `layer`
  (`repository`/`file`/`function`), `resultState` (the closed vocabulary
  documented in `server/lib/metrics.js` — `success`, `partial_success`,
  `timeout`, `validation_error`, `not_allowlisted`, `github_error`,
  `parser_failure`, `contract_violation`, `dependency_unavailable`,
  `internal_error`, `at_capacity`), `cacheStatus` (`hit`/`miss`).
- **Expected startup/recovery log lines** (all literally observed during
  this session's own manual verification against a real spawned server):
  `"server started"` (successful boot, includes the full resolved config
  summary), `"build info"` (the resolved `version`/`commitSha`/`dirty`),
  `"workspace startup sweep skipped"` (with a `reason` field — e.g.
  `root-not-previously-owned` on a genuinely first-ever startup) or
  `"workspace startup sweep complete"` (with `removed`/`failed` counts) —
  exactly one of these two always appears once per startup.

## Recovery

Beyond the release/domain rollback already covered above, three specific
failure modes and their real recovery procedures:

**Workspace disk fill.** Detect via Railway's own disk/resource metrics
for the `codeviz` service, or repeated `ENOSPC`-shaped errors in the logs.
**The fix is a restart or redeploy.** `WORKSPACE_ROOT` is not set as a
Railway environment variable on this deployment (confirmed — only
`AUTH_TOKEN`/`GITHUB_TOKEN`/`ALLOWED_OWNERS`/`BUILD_COMMIT_SHA`/`NODE_ENV`/
`PORT` are set), so `server/lib/config.js` defaults it to the container's
own OS tmpdir; `railway.json` declares no persistent volume. That means
the **entire container filesystem** — not just the workspace directories
`sweepStaleWorkspaces()` would selectively remove — resets on any restart
or redeploy. This is a stronger, simpler recovery than
`sweepStaleWorkspaces()`'s own narrower logic (which only ever removes a
directory whose lock file names a confirmed-dead PID, and would matter
more on a deployment with a persistent volume, which this one doesn't
have). Confirm recovery via `GET /readyz`'s `workspaceRoot`/`buildOutput`
checks passing again.

**Crash/restart survival.** `GraphCache` and the rate limiter
(`server/lib/rate-limit.js`) are both explicitly process-local — a crash
loses every cached graph and in-flight rate-limit window. Combined with
the point above, a crash-triggered restart also fully resets workspace
state on this deployment, for free — nothing further to clean up
manually.

**`GITHUB_TOKEN` revocation or expiry.** Surfaces per-request as a
`502`/`429` `github_access`-category error on every graph/analysis
endpoint, and separately (non-gating) via `GET /readyz`'s
`checks.githubReachable` (refreshed every 5 minutes in the background —
see `server/index.js`'s periodic `refreshDependencyStatuses` interval).
Rotate with `railway variable set GITHUB_TOKEN=<new value>` (mirrors the
existing `AUTH_TOKEN` rotation pattern already documented in
`docs/baseline.md`); confirm recovery via `/readyz` reporting
`githubReachable.ok: true` again.

## Dependency upgrades

`@codevisualizer/core` already has its own documented procedure — see
`docs/codevisualizer-core-dependency.md`'s "Update procedure"/"Rollback
procedure" sections; not duplicated here.

For everything else, no procedure existed before this commit. Verification
requirements differ by what's actually being bumped:

- **pyan3 / tree-sitter-wasms**: bump the pin (`requirements.txt` /
  `package.json`), `npm ci`, then run the full unit suite plus the two
  local-only smoke scripts (`tests/server-smoke.mjs`,
  `tests/e2e-construction-smoke.mjs` — both spawn their own local server,
  which is genuinely sufficient here since this is a pre-deploy check, not
  live verification of an already-running service).
- **playwright / vite**: same base steps as above, **plus**
  `tests/function-layer-smoke.mjs` specifically (the Playwright/
  browser-driven visual smoke test) — a server-only smoke check cannot
  catch a UI/browser-rendering regression, which is exactly what these two
  dependencies affect.
- **Node version, Python version (`railpack.json`), or the Railpack
  provider itself**: **cannot be verified locally at all** — these depend
  on Railway's own build image, which a local `npm ci && npm start` never
  exercises. Requires an actual Railway build: deploy to a non-production
  environment if one exists, or deploy directly followed by the same live
  `curl` checks in the cutover runbook's step 4 above, with the release
  rollback procedure on standby.

## Auth, allowlist, rate limiting, and secret handling — confirmed current state

All already implemented (MOO-67/72 Commits 3-6), reconfirmed here rather
than rebuilt:

- **Auth**: constant-time `AUTH_TOKEN` shared-secret check
  (`server/lib/auth.js`), required at startup with no environment-based
  bypass. Applied to every `/api/*` route.
- **Allowlist**: `ALLOWED_OWNERS`/`ALLOWED_REPOS` (`server/lib/allowlist.js`),
  at least one required at startup. **The deployed instance currently runs
  `ALLOWED_OWNERS=*`** (wildcard — any GitHub owner's repos, gated only by
  holding the shared `AUTH_TOKEN`) — see `docs/baseline.md`'s "Post-deployment
  update" section for when and why this was widened from the initial
  `OwenTanzer`-only allowlist. This is a **deliberate, already-made
  decision**, not an oversight — it was explicitly reaffirmed (not
  silently carried forward) at the moment of the actual DNS cutover (see
  "Cutover baseline" below).
- **Rate limiting**: in-memory fixed-window per-key limiter
  (`server/lib/rate-limit.js`, `RATE_LIMIT_PER_MINUTE`, default 30/min),
  not durable across restarts, not shared across replicas (single-instance
  design).
- **Secrets**: `AUTH_TOKEN`/`GITHUB_TOKEN` never logged directly
  (`server/lib/logger.js`'s exact-string plus shape-based redaction of
  GitHub-PAT/Bearer/query-string patterns).

## Rollback — two distinct controls, not one

**Release rollback** (a bad deploy, not a domain problem) — before any
deploy that matters (especially a cutover-related one), record the current
deployment's Railway deployment ID and git commit SHA here. Treat this as a
rolling habit, not a one-time entry — update it before every deploy that
changes what's running, not just at cutover time:

> _Last known good: (fill in before the next deploy that changes this)_
> - Deployment ID: `_____`
> - Commit SHA: `_____`
> - Recorded: `_____`

(See "Cutover baseline" below for the specific, historical record of what
shipped at the MOO-72 go-live — a fixed point in time, not this rolling
entry.)

Roll back via either:
1. **Dashboard**: Railway project `codeviz` → service `codeviz` →
   Deployments tab → the recorded last-known-good deployment → "⋯" →
   Redeploy. The only way to target a *specific past* deployment —
   `railway service redeploy` only redeploys the *latest* one.
2. **CLI, from a temporary worktree** (not `git checkout <sha>` in this
   working copy, which would disrupt any in-progress work here):
   ```
   git worktree add ../codeflow-rollback <last-known-good-commit>
   cd ../codeflow-rollback && railway up --detach -y --json
   git worktree remove ../codeflow-rollback   # once done
   ```

**Domain rollback** (DNS/Hub pointing somewhere broken, service itself
fine) — revert the Moopertonic Hub link and/or the Cloudflare CNAME back to
the prior state. The Railway-generated hostname
(`codeviz-production.up.railway.app`) keeps working underneath the whole
time; this is a routing fix, not a code fix, and never touches the running
deployment. These two failure modes are independent — the Railway hostname
was never itself a *release* rollback path, only a domain-level fallback.

## Cutover runbook (DNS + Moopertonic Hub) — as-executed record, reusable procedure

### Cutover baseline (historical — what actually shipped at go-live)

Live-verified this session via a real authenticated `GET /healthz` against
the production URL, returning this exact `commitSha`:

- **Date**: 2026-07-30
- **Deployment ID**: `9bbc1c73-2cfe-49f8-a273-e0ef7dde238c` (the
  `BUILD_COMMIT_SHA`-triggered redeploy that's actually serving live
  traffic; an immediately-prior deploy, `f324fd82-f152-4b67-a4f3-5ab9b888a8ed`,
  was superseded within the same session and never served the corrected
  commit provenance)
- **Commit SHA**: `7719075eb95712fd8f78e4fc2b3a5575f39b40e2` (merge of PR #18)
- **Custom domain**: `codeviz.moopertonic.net`, DNS-verified, TLS certificate
  valid
- **Moopertonic Hub link**: added and deployed (`OwenTanzer/moopertonic-hub`
  PR #4, merged, deployed via `wrangler deploy`)

This is a **fixed historical marker**, not an ongoing "last known good"
value — it will not be updated on future deploys. Use the "Release
rollback" section above's rolling entry for that.

### Reusable procedure (for a future re-cut, e.g. if the domain or Hub ever needs to move)

Per MOO-66/MOO-72's plan, scoped to this ticket, after all three layers are
structurally operational. Each numbered step below is a real production/
external-system change and should be proposed and confirmed individually,
immediately before being executed — this list is not a batch to run
unattended.

1. Explicitly confirm the target project/environment/service (`codeviz` /
   `production` / `codeviz`) before any command that touches it.
2. If a fresh deploy is part of the cutover, deploy with an auditable
   deployment message identifying it as the cutover deploy, and record its
   deployment ID and commit SHA in the "Release rollback" section above
   *before* proceeding to DNS.
3. Poll deployment status until it reaches a terminal `SUCCESS` — a queued
   or `--detach`'d deploy is not a completed one.
4. Run real checks against the **live URL** before touching DNS at all.
   `tests/server-smoke.mjs` and `tests/e2e-construction-smoke.mjs` cannot
   be pointed at a deployed URL — both hardcode a `localhost` port and
   `spawn()` their own server process, so they only ever test a server
   this same script starts. Use direct authenticated requests instead
   (these are the actual commands run against `codeviz.moopertonic.net`
   during the real cutover):
   ```
   curl -o /dev/null -w '%{http_code}\n' -X POST https://<host>/api/analyze-repo
   # expect 401 (no auth header)
   curl -o /dev/null -w '%{http_code}\n' -X POST https://<host>/api/analyze-repo -H "Authorization: Bearer wrong"
   # expect 401 (wrong token)
   curl https://<host>/api/capabilities -H "Authorization: Bearer $AUTH_TOKEN"
   # expect 200 with the real configured flag states
   curl -o /dev/null -w '%{http_code}\n' -X POST https://<host>/api/graph/repository \
     -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" \
     -d '{"owner":"octocat","repo":"Hello-World"}'
   # expect 200, a real analysis
   curl https://<host>/healthz
   curl https://<host>/readyz
   ```
5. `railway domain codeviz.moopertonic.net` (or via the dashboard) against
   the `codeviz` service — add **both** the routing CNAME and any
   ownership-verification record Railway returns; don't assume only one
   record is needed.
6. Add those exact records in Cloudflare's DNS for `moopertonic.net` in
   **DNS-only (grey-cloud) mode** until ownership verification and TLS
   issuance are both confirmed healthy — proxying (orange-cloud) before
   that can interfere with Railway's own certificate issuance.
7. `railway domain status codeviz.moopertonic.net` until it reports
   verified/healthy.
8. Only then, update the Moopertonic Hub link (`OwenTanzer/moopertonic-hub`
   — edit `index.html`, PR + merge to `main`, then **deploy with
   `wrangler deploy`**, since a plain `git push` does not update the live
   site; see the `viewer-wrangler-deploy` deployment pattern). Explicitly
   the last step, not done in parallel with DNS propagation. **When
   deploying via the `Temp\wr` wrangler workaround install, always run the
   binary against a separate clean directory containing only the site's
   own files** — copying site files directly into `Temp\wr` (which itself
   contains the wrangler CLI's own `node_modules`) will upload that
   `node_modules` as public static assets, as happened once during the
   real cutover before being caught and fixed with a redeploy.
9. **Reaffirm the `ALLOWED_OWNERS=*` decision explicitly at this point**
   (keep the wildcard, or narrow it) — a deliberate go-live choice made at
   cutover time, not an inherited default nobody revisited. (Reaffirmed as
   the wildcard at the actual MOO-72 cutover.)
10. Hold a defined observation window on the custom domain before deciding
    whether to keep or remove the Railway-generated fallback hostname —
    per the "Rollback" section above, the two are not equivalent; the
    Railway hostname was never a release-level rollback path, only a
    domain-level one. (Not yet decided as of the MOO-72 cutover — the
    fallback hostname `codeviz-production.up.railway.app` is still live.)
