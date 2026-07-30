# Deployment and operations runbook

MOO-72 Commit 8. This is the operational counterpart to `docs/baseline.md`
(a narrative commit-by-commit log) — a task-oriented reference for
deploying, rolling back, and operating this service. It documents the
**current, confirmed-implemented** state; the "Cutover runbook" section at
the end is the recorded procedure for the DNS/Hub cutover, not something
that has happened yet as of this commit.

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
  decision**, not an oversight — but it is also explicitly a cutover-gate
  item (see below): reaffirmed, not silently carried forward, at the
  moment of the DNS cutover.
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
deployment's Railway deployment ID and git commit SHA here:

> _Last known good: (fill in before the next deploy that changes this)_
> - Deployment ID: `_____`
> - Commit SHA: `_____`
> - Recorded: `_____`

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

## Cutover runbook (DNS + Moopertonic Hub) — recorded procedure, not yet executed

Per MOO-66/MOO-72's plan, scoped to this ticket, after all three layers are
structurally operational. Each numbered step below is a real production/
external-system change and gets proposed and confirmed individually,
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
4. Run authenticated smoke checks against the new deployment
   (`tests/server-smoke.mjs`, `tests/e2e-construction-smoke.mjs` pointed at
   the live URL) plus `GET /readyz`, before touching DNS at all.
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
8. Only then, update the Moopertonic Hub link — explicitly the last step,
   not done in parallel with DNS propagation.
9. **Reaffirm the `ALLOWED_OWNERS=*` decision explicitly at this point**
   (keep the wildcard, or narrow it) — a deliberate go-live choice made at
   cutover time, not an inherited default nobody revisited.
10. Hold a defined observation window on the custom domain before deciding
    whether to keep or remove the Railway-generated fallback hostname —
    per the "Rollback" section above, the two are not equivalent; the
    Railway hostname was never a release-level rollback path, only a
    domain-level one.
