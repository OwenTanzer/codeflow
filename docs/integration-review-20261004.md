# Coordinated integration review

This draft integrates issues #27, #28 and #29 without closing their acceptance gates. The original PRs remain intact. Do not interpret green CI as complete browser or label acceptance.

## Provenance

Base main: `a4589e1f4a0b2b4e8627a7113a315812a447da44`.

Merged without rewriting history, in this order:

1. PR #31: `3c59c4586b4c11b1b0d0a21fa5b44851c23c2657`.
2. PR #33: `69f2991d5821af11eeaae40affd7e86f69224582`.
3. PR #32: `1289b95166656a1c858e75ed25a3fd685f4471a0`.

The renderer cleanup conflicts retain activation disposal, font-listener cleanup and simulation shutdown. The common HTML and function smoke were inspected after the textual merge. Repair work adds metadata request cancellation/draining, complete repository search, initial-load cancellation, exact source-preview text and stale-preview cleanup, selectable unsupported overview nodes, explicit Python-only deeper navigation, renderer lifetime cleanup, and measured dense-label layout/fit behavior.

## Reproduction

Use the documented setup in README and package scripts. Run `npm ci` with the pinned CodeVisualizer checkout and a working pyan3 Python interpreter. No lint/type script is defined; `npm run build` includes the vendored core TypeScript build.

Core gates:

- `npm test`
- `npm run build`
- `node tests/server-smoke.mjs`
- `node tests/e2e-construction-smoke.mjs`

Serve the built app with the ordinary server. Server-side GitHub access must use existing authorized credentials, never a browser token or Authorization header. Browser integration commands accept a local app URL:

- `node tests/ui-smoke.mjs http://127.0.0.1:4334/`
- `node tests/function-layer-smoke.mjs http://127.0.0.1:4334/`
- `node tests/interaction-repairs-smoke.mjs http://127.0.0.1:4334/ <output-directory>`
- `node tests/integration-overview-browser.mjs http://127.0.0.1:4334/ <output-directory>`; set `OVERVIEW_TREEMAP=1` for alternate-view coverage.
- `node tests/integration-preview-browser.mjs http://127.0.0.1:4334/ <output-directory>`

Renderer tests import local source modules and therefore use Vite, with the ordinary API proxy setup:

- `LABEL_TEST_URL=http://127.0.0.1:5134/ node tests/full-labels-browser.mjs`
- `node tests/function-reflow-browser.mjs http://127.0.0.1:5134/`
- `node tests/dense-labels-browser.mjs http://127.0.0.1:5134/ <captured-repository-response.json> <output-directory>`

The overview captures the actual parsed bridge response without mutating it; DevTools response-body eviction on the roughly 20.8 MB result is not an application failure. Fault injection and graph replay are explicitly identified in structured output. Interaction ref cases inject the requested ref at the bridge seam; they do not establish pasted `/tree/ref` URL support. Document-injection tests use the production server to avoid Vite HMR websocket artifacts. Normal rate-limit windows remain in effect.

## Acceptance still blocked upstream

CodeVisualizer remains pinned at `974d907a5490aa96fb8e84b6723d15bc5455c658`. Six source-oracle completeness cases lose text upstream: for, with, return, ternary true/false, and higher-order assignment. The full-labels gate must remain red until an approved upstream change preserves original text. No lost text is invented here, and no pin is changed.

A separately approved upstream proposal would add versioned raw text with parser-composition provenance before presentation escaping, preserving legacy labels/IDs/edges/locations. It needs parser attachment, tests of the existing service passthrough, both higher-order assignment sites, source-oracle tests and compatibility snapshots; the prior rawLabel proposal is not applied or assumed correct.

Kotlin/Java remain limited heuristic repository overviews. Their source and ownership can be inspected, but deeper navigation is unavailable. OA-210 semantic reconciliation is outside this integration. Chromium touch emulation is not physical iOS/Android coverage. Unconfigured private-repository smoke fixtures remain unrun.

The private results report records the exact final tested commit, command exits, fresh live/cache measurements, failed attempts, independent review and remote checks. Runtime evidence is retained separately rather than committed into the repository.

## Alternate view follow-up

The independent final audit found pre-existing visual subset caps in Matrix, Tree, Flow, Cluster and Bundle. They are separate from the already uncapped repository retrieval. The repair removes these view caps while keeping Matrix sparse: empty cells share one background plane and dependency cells scale with actual edges instead of file-count squared. Full labels use measured bounds and separate fit/readable controls, with font/resize cleanup and keyboard focus into the readable view. Flow retains its explicit unsupported-cycles message; semantic reconciliation is outside this change.

Run `node tests/alternate-views-browser.mjs http://127.0.0.1:4334/ <output-directory> <captured-repository-response.json>` for the five repaired views. This is explicitly a captured real-response replay, with source-coordinate filename/folder oracles. Broader 3D camera legibility and architecture aggregate semantics are not established by this test.
