# Codeflow #28 local repair review

> Status note — October 4, 2026: Historical lane review. The later [integration acceptance](integration-acceptance-20261004.md) records the merged upstream raw-label repair and downstream adoption; use the [documentation index](README.md) for current architecture and release status.

This is a partial, reviewable implementation, not full acceptance or deployed functionality.

## Scope
SVG function labels wrap without dropping characters or limiting line count. SVG text measurement sets node dimensions and rank spacing. Rectangles, diamonds, and terminal ellipses enclose the measured text. Edge anchors use those dimensions; existing right-side loop lanes use the widest final node. Repository/file SVG labels retain complete names, and zoom below 0.45 hides them as a whole.

The adapter recovers exact source text only for audited paths in the pinned Python parser whose labels correspond to the attached syntax node (stmt, cond, elif_cond, while_cond, raise). It verifies the pinned upstream encoding against the actual label, allowing the parser's second escape pass. Other generated labels remain upstream labels; uncertain ellipses produce a warning. The original source string is not decoded as Mermaid, preserving source-literal entities, escapes and ellipses.

## Exact upstream boundary
Dependency: OwenTanzer/CodeVisualizer at 974d907a5490aa96fb8e84b6723d15bc5455c658.
packages/core/src/core/utils/StringProcessor.ts shortens escaped strings at 80 characters.
packages/core/src/core/common/AbstractParser.ts createSemanticNode escapes again.
packages/core/src/core/language-services/python/PyAstParser.ts also composes labels from already escaped fragments. Examples: ternary assignments, higher-order call expansion, and for headers whose location includes the entire body.
Complete original semantic labels are not exported. A reviewed upstream raw-label field (preserved before shortening/composition) and dependency update are required for general completeness. No vendor monkeypatch, dependency repin, or invented suffix is included.

## Reproduction on MSI
Node v24.15.0; Windows 10.0.26200; Playwright Chromium 149.0.7827.55.
Run npm ci, then set PYTHON_BIN to the checkout's .venv-pyan3/Scripts/python.exe before npm test.
Run npm run build. For the existing app smoke, start the server with an existing server-side GitHub credential, ALLOWED_REPOS=psf/requests and PORT=3028, then:
node tests/function-layer-smoke.mjs http://127.0.0.1:3028/

The isolated renderer browser regression needs a local Vite server at http://127.0.0.1:5128/:
npm run dev -- --host 127.0.0.1 --port 5128
node tests/full-labels-browser.mjs
Its evidence goes to .git/lane28-browser.json and .git/lane28-{1680,390}.png. This is an isolated renderer test, not the full application or mobile touch acceptance.

Requests fixture: psf/requests commit 611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60, src/requests/sessions.py, copied byte-for-byte to tests/fixtures/python-symbols/requests-sessions-pinned.py. Retains its original source/license header.
The inline full-labels.test.mjs fixture contains >80-character source, multiline text, escaping, literal ellipses, punctuation boundaries and long unbroken identifiers.

## Unresolved acceptance limits
- General generated-label completeness requires the upstream change described above.
- Alternative visualizations in index.html (treemap/matrix/etc.) still contain their existing abbreviation rules. They were audited but not rewritten in this partial patch.
- Repository/file label collision spacing remains based on node shapes, not complete label bounds; dense labels can overlap.
- Function forward edges that skip ranks may still cross intermediate nodes; edge-label placement can intersect a node. Shape overlap tests do not establish edge-route clearance.
- Width is measured at render time. Existing render triggers remeasure; an independent font-load/resize observer is not added.
- Graphs can extend beyond the viewport and remain pannable; the tests do not equate off-screen nodes with clipped text.
- Browser checks use desktop Chromium at desktop and narrow viewport sizes; no real iOS/Android or touch-gesture acceptance is claimed.
- Full app smoke retains the lane #27 fetchBlame bridge error.

## Integration
No index.html changes. Shared files: src/render/fileGraph.js and repositoryGraph.js, limited to label and zoom blocks; reconcile with lane #27 interaction hooks. tests/function-layer-smoke.mjs changes its label selectors and pins Requests; reconcile with lane #27 smoke extensions.
package-lock.json and codevisualizer-core.lock.json remain unchanged.
Do not merge/deploy or close #28 based on this partial result. Reconcile all lanes in a separate integration checkout and rerun combined acceptance.

## Run 2 correction status

Run 1 is partial, not accepted. The current CodeVisualizer pin
974d907a5490aa96fb8e84b6723d15bc5455c658 still irreversibly shortens composed
labels. Run 2's independent source oracle intentionally makes browser acceptance
fail until the upstream contract is approved and implemented. A renderer-only
pass or a warning does not establish completeness.

The proposed additive node contract is rawLabel = {version: 1, text,
provenance: "python-parser-composition"}. text is captured before ANY
StringProcessor call; it is never Mermaid-decoded. location remains a navigation
span, not proof that a header equals its whole body. The local adapter and render
model preserve this contract when present. The current pin does not emit it.
Source-literal ellipses and literal entity-looking text remain literal.

An UNAPPLIED three-file proposal for OwenTanzer/CodeVisualizer is included in
the Run 2 evidence bundle: IR type, Python parser raw pass, and Python service.
It bypasses shortening during a separate parser pass while preserving existing
Mermaid labels, and replaces both generated higher-order assignment placeholders
with the authoritative assignment text in that raw pass. This is a review
proposal, not a tested upstream fix. It needs owner authorization, complete
upstream regression/extension compatibility tests, an audit of fallback
"with ..." and other synthetic recipes, and performance measurement before use.
No upstream files, dependency pin or package-lock.json changed. The proposed
pin transition is from the current SHA to the future reviewed upstream commit;
no new SHA exists or is fabricated.

Local rendering changes reserve measured label collision envelopes, restore
folder zoom visibility on every hull recreation, route skipped ranks and loops
outside node shapes, keep edge labels in rank gaps, and reflow function geometry
on font loading or viewport resize. Function fit measures actual rendered bounds;
readable view returns to the entry. Alternate label blocks retain extensions and
complete folder names; treemap labels are arranged beside the cells rather than
clipped to tiny cells. Large complete labels can expand the graph far beyond the
viewport; this is distinct from shape overlap and requires pan/fit.

Run local checks from the isolated checkout:
- Set PYTHON_BIN to .venv-pyan3/Scripts/python.exe on MSI.
- npm test
- npm run build (the documented bootstrap reinstalls/builds the pinned core).
- npm run dev -- --host 127.0.0.1 --port 5128 --strictPort
- node tests/full-labels-browser.mjs
- CODEFLOW_SMOKE_FIXTURE=labels node tests/function-layer-smoke.mjs http://127.0.0.1:5128/
- Repeat with CODEFLOW_SMOKE_WIDTH=390.

The last two environment assignments use shell-appropriate syntax (PowerShell:
$env:CODEFLOW_SMOKE_FIXTURE='labels'). Fixture mode intercepts local API calls
using the pinned Requests parser graph and a synthetic repository/file envelope.
It is NOT live GitHub acceptance. The existing console-error gate remains active,
including fetchBlame. Live acceptance must be rerun after access is available and
the three lanes are integrated. No real mobile device is covered by viewport
emulation.

Shared-file hotspots: repositoryGraph collision setup/hull labels/cleanup;
fileGraph collision setup/font cleanup; index.html FunctionGraphCanvas fit
controls, treemap/matrix/dendrogram/bundle label callbacks and repository fit
bounds; function-layer-smoke fixture hook, viewport/output paths and assertions.
This list is not exhaustive until #27 and #29 diffs are available. No bridge,
metadata repair, ref badge, retrieval, cancellation or mobile gestures are owned
by this patch.
