# File layer known limitations and Garrison Step handoff (MOO-70 Commit 9)

Records known static-analysis limitations of the pyan3 + tree-sitter file
layer and defers aesthetic/correctness judgment to the Garrison Step
(MOO-44), matching `docs/repository-layer-density.md`'s own precedent for
the repository layer — this is a documentation-only commit; the
limitations below are inherent to the analyzer combination, not gaps this
issue chose to leave unfixed.

## Known static-analysis limitations

- **Calls/imports to code outside the analyzed file(s) are invisible.**
  Confirmed via a real spike (`tests/fixtures/python-symbols/external_refs.py`):
  a call into an unstaged sibling module, a third-party package (`requests`),
  or a call to an undefined name all produce **no node or edge at all** in
  pyan3's own output — not a placeholder "unresolved" node. Tree-sitter
  (`server/lib/pythonSymbolIndex.js`) only indexes *definitions*, never
  call-sites, so it has no independent signal either. The two analyzers
  together cannot detect that an invisible reference exists, so nothing in
  `server/lib/pyanSymbolJoin.js` or `src/adapters/fileGraphAdapter.js`
  attempts to represent it — there is no per-graph warning for this
  either, since neither analyzer reports a count to warn about. This is
  the single largest scope boundary of the whole file layer: **only
  relationships between symbols in the exact requested file/package are
  ever shown.**
- **Framework-level and dynamic-dispatch reachability is not tracked.**
  pyan3's static call-graph analysis cannot see through dependency
  injection, plugin/registry patterns, `getattr`-based dispatch,
  decorators that rewrite call targets at runtime, or metaclass-driven
  attribute creation. A method that is only ever invoked through such a
  mechanism will appear to have no callers (or, symmetrically, calls it
  makes that are resolved dynamically will not appear as edges).
- **Same-name redefinitions in one scope resolve via last-definition-wins,
  not true per-overload/per-accessor semantics.** `typing.overload` stub
  signatures, `@property`/`@x.setter`/`@x.deleter` triples, and
  conditional `if PY2: def x / else: def x` patterns all produce multiple
  tree-sitter definitions sharing one qualified name. `pyanSymbolJoin.js`
  resolves these by picking the entry with the highest `startLine` (found
  and fixed against a real fixture — `psf/requests`' `models.py` — see
  commit 0f9a771), matching pyan3's own one-node view and Python's actual
  runtime name-shadowing behavior. This means: (a) a property's getter and
  setter are shown as one merged node/range (the setter's, if it comes
  last), not as distinct getter/setter symbols; (b) `typing.overload` stub
  signatures are invisible individually — only the real implementation's
  range is shown.
- **Depth-mode thresholds are initial, untuned guesses.** `src/graph-ir/depthPolicy.js`'s
  node/edge budgets (60/120) and the file-size cutoff (20 symbols) were
  chosen for internal consistency, not validated against real large
  Python files/packages — no fixture in this repository is large enough
  to do that, the same caveat `repository-layer-density.md` gives its own
  300-node threshold.

## Production Python dependency (PR review follow-up)

CI (`.github/workflows/test.yml`) has installed the pinned `pyan3==2.6.2`
via `actions/setup-python` + pip since Commit 2, but nothing declared this
dependency for an actual deployment until this note: `requirements.txt`
(repo root) is the pinned manifest, and `package.json`'s `postinstall`
script (`scripts/install-pyan3.mjs`) attempts to `pip install` it
right after `npm install`/`npm ci` — piggybacking on the Node install step
Railpack already runs for this repo (detected as a Node-primary app via
`package.json`), rather than depending on Railpack-specific multi-language
config syntax.

**Explicitly not verified**: whether Railway's Railpack build image has
Python/pip available by default for a Node-detected service, or whether
additional Railway service configuration (e.g. `RAILPACK_BUILD_APT_PACKAGES`
to ensure `python3`/`pip` exist in the build image — see
[Railway's build configuration docs](https://docs.railway.com/builds/build-configuration))
is required on top of this. This repository has no live Railway deployment
this work could exercise, so this is flagged rather than asserted as
already working. If `python3`/`pip` are absent from the build image, the
postinstall script's `spawnSync` calls simply fail (same as a missing
binary today) and it logs a warning without failing the build — the
runtime already handles this by serving `/api/graph/file` in degraded
tree-sitter-only mode (see below) rather than crashing, so a missing
production pyan3 install degrades functionality, it does not break the
deployment.

## Cross-layer resilience (Commit 9's own checklist item)

A pyan3 failure for one `/api/graph/file` request is isolated to that
request/response — verified directly (`tests/server-graph-file.test.mjs`,
`runPyan3ForFile`'s forced-failure test) rather than assumed:
`server/routes/graph-file.js`'s pyan3 step never throws past its own
boundary, degrading to a tree-sitter-only graph instead. This request
handler shares no mutable state with `server/routes/graph-repository.js`'s
handler (each is an independent closure over the same read-only `config`
object) and the client's repository-graph rendering
(`src/render/repositoryGraph.js`) is an entirely separate code path from
the file layer's (`src/render/fileGraph.js`) — a file-layer failure
cannot reach either. `server/index.js` checks pyan3 availability once at
startup (`verifyPyan3Available`, wired in Commit 7) purely for early
visibility in the logs — **revised after PR review**: this originally
called `process.exit(1)` on failure, which took the *entire* server down
(repository layer and static app included) over a capability only the
file layer needs, directly contradicting this same "keep the repository
layer operational when pyan3 fails" requirement. It's now non-fatal: a
missing/broken pyan3 install is logged as a warning
(`pyan3Available: false` in the startup log, and surfaced non-gating in
`/readyz`'s `checks.pyan3`), and the server continues — every
`/api/graph/file` request then hits the same already-tested per-request
degradation path described above.

## Garrison Step handoff notes

Deferred from Commit 8 (rendering), mirroring
`repository-layer-density.md`'s own list of deferred repository-layer
work — real design decisions better made with actual large-repository
usage evidence than guessed at now:

- **Convex-hull group visualization.** The repository layer draws folder
  hulls; the file layer's `groupId`-based force clustering
  (`src/render/fileGraph.js`) currently has no equivalent visual boundary
  around a class's members.
- **Full-text search, match cycling, directional emphasis beyond drawn
  edges** ("Raven patterns" from the original ticket). No existing analog
  for these exists anywhere in this codebase (confirmed: no
  "search"/"Raven" reference anywhere in `index.html` or `src/`) — building
  them now would be inventing new UI design without a validated pattern to
  follow, the same reasoning `repository-layer-density.md` gives for not
  speculatively building clustering/node-budget UI.
- **Node-budget-driven reduction *within* a chosen depth mode** (e.g. "of
  the 40 methods in this class, show only the 10 most-connected") — today
  `depthPolicy.js` only ever picks a coarser/finer *mode*, never drops
  individual nodes within one. Exactly the kind of judgment
  `repository-layer-density.md` reserves for the Garrison Step.
- **Aesthetic questions worth revisiting with real usage:** is
  last-definition-wins the right visual representation for
  `@property`/`typing.overload` groups, or should the UI show "3
  overloads" as an explicit badge instead of silently picking one range?
  Should `symbolOnly` nodes (identity known, no relationship data) be
  visually distinguished more strongly than the current dashed-stroke
  treatment? Should unresolved/ambiguous nodes get a distinct shape, not
  only the current `colorRole:'warning'` tint?
