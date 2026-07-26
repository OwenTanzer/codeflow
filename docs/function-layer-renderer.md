# Function-layer renderer: shared vs. specialized

MOO-71 Commit 7. MOO-71's governing decision is to *prefer the shared renderer
and interaction contract, but allow a specialized function renderer if
usability requires it*. This records the actual comparison that decision was
made on, rather than asserting the outcome.

## Method

One real function-layer GraphIR was rendered through both renderers, with the
renderer as the only variable. No data was altered between the two.

- **Subject:** `psf/requests` `SessionRedirectMixin.resolve_redirects`
  (`src/requests/sessions.py`), at commit
  `69f84847045bef7a849cc994a26fe7ba8a169e95`.
- **Graph:** 55 nodes, 65 edges — 1 entry, 1 exit, 9 branches, 44 statements;
  47 `flow`, 9 `flow-true`, 9 `flow-false`. Real loops, so real back-edges.
- **Produced by:** the actual pipeline — `POST /api/graph/function` →
  `pythonSymbolIndex` → `@codevisualizer/core` → `functionGraphAdapter`.
- **A:** `src/render/fileGraph.js` (`renderFileGraph`), **unmodified**, given
  6 seconds to let its force simulation settle so it was not judged half-cooled.
- **B:** `src/render/functionGraph.js` (`renderFunctionGraph`).

Screenshots: `img/function-force.png`, `img/function-layered.png`,
`img/function-renderer-comparison.png`.

## Result

| | Shared force renderer (A) | Layered renderer (B) |
|---|---|---|
| Reading order | None. Entry and exit land wherever the simulation pushes them — in the captured run `Start` sits top-right and `End` mid-left. | Entry at rank 0, exit at the last rank, one rank per execution step. |
| Loops | Back-edges are indistinguishable from forward flow; a cycle is not visible as a cycle. | Detected by DFS and drawn as dashed amber curves in lanes outside the node column. |
| Branch semantics | `flow-true` / `flow-false` are drawn identically, so which way a condition goes is unrecoverable. | Labelled `true`/`false` in green/red; loop and `on <Error>` labels drawn inline. |
| Sequential statements | Scattered into a ring by charge repulsion. | Stacked down one spine. |
| Determinism | Force layout re-settles differently per run. | Same input → byte-identical layout (asserted in `tests/function-render-model.test.mjs`). |

**Verdict: the force renderer is materially worse for control flow.** Not a
matter of polish — a force simulation has no way to express that a
control-flow graph *has* a correct order, which is most of what makes a
flowchart worth looking at. The specialized renderer is justified under the
ticket's own allowance.

## What stayed shared

The fallback is specialized, not divergent:

- Same input: the function-layer GraphIR the adapter already produces. No
  renderer-specific analysis, and choosing a renderer does not alter data.
- Same option contract as `renderFileGraph` (`svgEl`, `graph`, `theme`,
  `zoomRef`, `selectSymbolRef`, `activateSymbolRef`, `onHover`,
  `onBackgroundClick`), returning the same cleanup function — so either
  renderer drops into the other's call site.
- Same interaction contract (`src/graph-ir/navigation.js`): single click
  selects, double click carries drill-down intent.

The returned cleanup function additionally carries `applySearch` and
`applySelection`, so highlighting does not require re-rendering the SVG and
discarding the user's zoom/pan on every keystroke. Callers that only invoke
cleanup — like the file layer's — are unaffected.

## Two defects the screenshots caught that the unit tests could not

Both were real bugs in the layered renderer, found only by looking at output:

1. **Fit-to-height made every label unreadable.** A 55-node function is ~40
   ranks deep; fitting that into a 420px panel forced ~0.2 scale. Fixed by
   fitting *width*, anchoring at the entry, and refusing to scale below
   `MIN_SCALE` (0.55) — a control-flow graph is legitimately tall, and the
   useful default is a readable scale you pan down, not a whole graph you
   cannot read. `RANK_HEIGHT` also dropped 84 → 60.
2. **Long back-edges swept across the node column.** Routing lanes were
   computed from the two endpoints, so a `continue` from rank ~35 to a loop
   header at rank ~6 cut diagonally across everything between, drawing a large
   X over the graph. Lanes now sit to the right of the *entire* drawing, and
   the initial fit accounts for their width.

## Verified in the running app

`tests/function-layer-smoke.mjs` (MOO-71 Commit 8) drives the whole path
through the real UI — repository → file → function → back — against
`psf/requests`. Not part of the zero-setup `node --test` suite; it needs a
running server plus a GitHub PAT and the server token:

```
node tests/function-layer-smoke.mjs http://localhost:3000/ <githubPat> <serverToken>
```

Latest run, drilling into `SessionRedirectMixin.resolve_redirects`:
55 nodes, 3 dashed loop back-edges, 18 true/false branch labels, 1 `on <Error>`
exception label, 0 Mermaid entities, 0 console errors. `img/function-layer-in-app.png`
is that view inside the app.

The back-navigation check asserts on *request counts*, not appearance: after
repository → file → function → back, exactly one `/api/graph/file` request has
been issued in total, proving the file view was restored from cache rather than
re-analyzed.

## Failure isolation and diagnostics (MOO-71 Commit 10)

Each stage of a function request reports a distinct `ErrorCategory`, so a
failure names what actually broke rather than collapsing into a generic 500:

| Stage | Category | Status |
|---|---|---|
| Repository not allowlisted / bad input / unresolved or ambiguous symbol | `unsupported_input` | 400/403/404 |
| PR head moved since the parent graph loaded | `unsupported_input` | 409 |
| GitHub fetch failed / rate limited | `github_access` | 502/429 |
| Analysis exceeded its budget | `timeout` | 504 |
| **Source has syntax errors** | `parser_failure` | 502 |
| **Our offset conversion disagrees with CodeVisualizer's parse** | `malformed_analyzer_output` | 502 |
| Anything genuinely unexpected | `internal_error` | 500 |

The two bolded rows were previously one. `@codevisualizer/core` raises a single
`FunctionRangeNotFoundError` for both, because tree-sitter is error-tolerant —
it never throws on a syntax error, it returns a tree containing ERROR nodes, so
unparseable source arrives as "no function matches that exact range" rather than
as a parse error. Everything was therefore reported as *"Internal conversion
error"*, telling users we had a bug when their file simply was not valid Python.
`classifyFunctionRangeFailure` splits them using `errorRanges` — byte ranges of
every ERROR/MISSING node, collected by the symbol index from the same parse
that already computes `tree.rootNode.hasError()`, so it costs no extra parse.
The check is target-local: it looks for an error range overlapping the
specific function's own `[startByte, endByte)`, not whether the file has a
parse error anywhere. A file-wide check would mislabel a clean function's own
bug as `parser_failure` merely because some unrelated function elsewhere in
the file fails to parse. The panel adapts its wording too: retrying is
pointless for a parse failure, it says so, and the Retry button itself is
hidden in that case rather than left inviting a useless request.

**Layer isolation** is structural rather than defensive: each layer is a
separate panel with its own fetch and error state, and since MOO-71 Commit 8 the
repository and file graphs are restored from cache on back-navigation without
re-analysis — so a failing function request cannot disturb, invalidate, or
require re-running the layers above it. `tests/function-layer-smoke.mjs` exercises
that path end to end.

## Known limitations, for MOO-44's Garrison matrix

- **`for...else` is dropped upstream.** A `for` loop's `else` clause produces
  no node at all — verified against a fixture whose `else` body was silently
  absent from the FlowchartIR. A `@codevisualizer/core` limitation, not an
  adapter or renderer one.
- **No callee drill-down.** A call node's coordinate is the *enclosing*
  function's, not the callee's (see `functionGraphAdapter.js`'s
  `nodeCoordinate`), so no reliable target coordinate exists. Double-click
  explains this rather than navigating somewhere plausible but wrong.
  Following calls needs a real call-graph edge the adapter does not yet
  produce.
- **Crossing reduction is one barycenter pass.** Enough for the functions
  tested; a much wider branch fan-out may want more passes. Deliberately not
  built speculatively.
- **Labels truncate at 20 characters** in-shape, with the full text on hover
  and in the metadata panel. `@codevisualizer/core` itself already truncates
  at 80.
