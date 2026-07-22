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
cannot reach either. `server/index.js`'s one exception it cannot recover
from is pyan3 being entirely unavailable (wrong/missing binary) at
**startup** (`verifyPyan3Available`, wired in Commit 7) — a deliberate
fail-fast choice distinct from a per-request crash, so a broken deploy is
caught immediately rather than surfacing as confusing per-request 500s.

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
