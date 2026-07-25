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
