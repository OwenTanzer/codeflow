# CodeVisualizer core dependency

Read [the architecture guide](architecture.md) for the function dataflow and
[deployment.md](deployment.md) for operations. The current source baseline is
`7ce7aa8020bc9bdf0c70648d175632e19f65b7d6` (October 4, 2026).

## Current wiring

- `codevisualizer-core.lock.json` pins `OwenTanzer/CodeVisualizer` at
  `ea0f56d929375794c1b9e423bede9a91328f7ed8`, workspace `packages/core`.
- `package.json` consumes `@codevisualizer/core` through
  `file:.vendor/codevisualizer/packages/core`. The package's own version is
  `0.1.0`; the git lock identifies the actual parser revision.
- `npm ci`/`npm install` invokes `setup:codevisualizer` through `preinstall`;
  `npm run build` invokes it again before build-info generation and Vite.
  These are both real setup paths, not future integration steps.
- `scripts/setup-codevisualizer-core.mjs` clones when the pin differs, verifies
  HEAD, then **always** resets/cleans the disposable vendor checkout, runs its
  root `npm ci`, and builds `packages/core`. An already matching HEAD skips
  only re-cloning. Never keep authored changes under `.vendor`: setup deletes
  them intentionally. Failures stop the parent install/build.
- `server/index.js` calls `initPythonLanguageService`; the function route calls
  `analyzePythonFunction`. The core is actively used, not merely provisioned.
- The pinned parser supplies versioned `rawLabel` text with
  `python-parser-composition` provenance. The function adapter, geometry and
  browser source-oracle gates preserve complete labels across that boundary.

The vendor build currently installs the extension repository's root development
dependencies before building the small core. This is an observed setup cost,
not proof that runtime analysis is slow. See [profiling](architecture-profiling.md)
and [ranked options](architecture-next-steps.md). Isolated provisioning would
need a separately scoped CodeVisualizer proposal; this task does not change it.

## Update and rollback

1. Obtain an approved, reviewed upstream commit; update the exact git lock.
2. Run `npm ci` and `npm run build`; inspect the vendor HEAD and resolved core.
3. Run root tests with the correct pyan3 interpreter, server/function gates,
   Unicode/range tests and the full-label source-oracle browser suite.
4. Review the lock and any intentional package-lock changes, then commit only
   authored tracked files. Do not commit `.vendor`, credentials or runtime data.

Rollback changes the git lock to the prior reviewed commit and repeats setup
and verification. A package version string alone is not the parser identity.
The production deployment procedure remains in the runbook and is separately
authorized.

The following original test record is preserved verbatim apart from its heading.
Its statement that server/src did not call the core was true at that stage and
is superseded by the current wiring above. These are not tests run for this PR.

## Historical verification at MOO-71 Commit 4

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
