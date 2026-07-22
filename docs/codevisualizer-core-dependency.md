# @codevisualizer/core dependency (MOO-71 Commit 4)

CodeFlow's function layer (MOO-71) consumes `@codevisualizer/core`, the
Python parser→FlowchartIR pipeline extracted from the
`OwenTanzer/CodeVisualizer` VS Code extension
(`CodeVisualizer-fork` locally) in that repo's own MOO-71 Commits 1-3
(merged as [CodeVisualizer#1](https://github.com/OwenTanzer/CodeVisualizer/pull/1)).

## How it's wired in

- `codevisualizer-core.lock.json` (repo root) is the single source of
  truth: the fork's git URL, the exact pinned commit, and which workspace
  package to build (`packages/core`).
- `scripts/setup-codevisualizer-core.mjs` runs as a `preinstall` script
  (before `postinstall`, and before `npm` resolves/links this project's
  own `dependencies`): it clones the fork at the pinned commit into
  `.vendor/codevisualizer/` (gitignored, fully reproducible from the lock
  file — never commit anything under it), installs that vendored repo's
  own dependencies, and builds `packages/core`.
- `package.json`'s `dependencies` then resolves
  `"@codevisualizer/core": "file:.vendor/codevisualizer/packages/core"`
  to that freshly-built package. `npm install`/`npm ci` alone is the
  complete "install and build" command — no separate manual step.

**Why `preinstall`, not `postinstall`**: npm resolves/links `file:`
dependencies as part of the same `npm install` that runs
`preinstall`/`postinstall`, but the linking step happens *between* them
— `preinstall` first, then dependency resolution, then `postinstall`.
Since the vendored target doesn't exist on a fresh checkout, the `file:`
entry can only resolve if the vendoring already ran, which requires
`preinstall`. (The existing pyan3 provisioning stays on `postinstall` —
it isn't an npm dependency, so this ordering constraint doesn't apply to
it.)

**Why not a git submodule** (the ticket's stated preference): this
project's actual Railway deployment (see MOO-70) runs via `railway up` /
the Railway MCP's `deploy` tool, which tars up whatever's already on disk
in the local checkout — it never invokes git, so it would never run
`git submodule update --init`. A submodule would only deploy correctly
if whoever runs the deploy happened to have it initialized locally
first, with no automatic safety net. This pinned-checkout-via-preinstall
approach runs on every `npm install`/`npm ci`, including whatever a
deploy operator runs before `railway up` — and mirrors this repo's own
established pattern for the pyan3 dependency (MOO-70 Commit 9: pin a
version, provision automatically via an npm lifecycle hook, gitignore
the provisioned artifact).

## Update procedure

1. Get the new commit SHA to pin (typically a freshly merged PR in
   `OwenTanzer/CodeVisualizer`).
2. Edit `commit` in `codevisualizer-core.lock.json` to that SHA.
3. Run `npm install` (or delete `.vendor/codevisualizer/` first if you
   want to force a full re-clone rather than rely on the script's own
   pinned-commit check).
4. Confirm `npm test` still passes and re-run any function-layer smoke
   test that exercises the new behavior.
5. Commit the updated lock file.

## Rollback procedure

Identical to the update procedure, just set `commit` back to the
previous known-good SHA and reinstall.

## Known trade-off (not fixed here)

`setup-codevisualizer-core.mjs` runs `npm ci` at the **vendored repo's
root**, pulling in the whole CodeVisualizer extension's devDependencies
(webpack, eslint, `vsce`, ~350 packages) just to build the one small
`packages/core` workspace. This is because `packages/core`'s own build
script currently relies on `typescript`/`rimraf` via npm workspace
hoisting from that root, rather than declaring them as its own
`devDependencies`. Making `packages/core` installable/buildable in
complete isolation would be a legitimate, small follow-up in
`CodeVisualizer-fork`, but wasn't required for this commit to work
correctly and would have meant another PR-review round in that repo
before this one could land.

## Verified

- A truly clean checkout (`rm -rf node_modules .vendor && npm install`)
  succeeds and resolves `node_modules/@codevisualizer/core` to a real,
  built package (not a dangling symlink) — confirmed by importing it and
  running a real Python parse end-to-end from `codeflow-tool`.
- Pointing the lock file at an earlier pinned commit (before
  `CodeVisualizer-fork`'s Commit 3) and reinstalling genuinely removes
  `analyzePythonFunction`/`resolvePythonWasmPath` from the resolved
  package; restoring the real pin and reinstalling brings them back — a
  real behavioral diff, not just a file-timestamp check.
- Nothing under `.vendor/` is git-tracked after install.
- `npm test` (380/380) and the existing server startup are both
  unaffected — nothing in `server/`/`src/` calls into
  `@codevisualizer/core` yet; that's MOO-71 Commit 5.
