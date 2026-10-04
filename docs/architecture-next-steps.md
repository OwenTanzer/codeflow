# Incremental architecture plan and regression ownership

Read [architecture.md](architecture.md) first. Evidence is source-inspected at `7ce7aa8020bc9bdf0c70648d175632e19f65b7d6`, October 4, 2026. These are proposals under [#30](https://github.com/OwenTanzer/codeflow/issues/30), except the first identity-helper extraction recorded below. #27–29 remain open for acceptance reconciliation. No recommendation below claims hosted speed gains.

## Ranked sequence

### 1. Extract only the shared route identity helpers

**Implemented first slice:** `server/lib/graph-request-context.js` now owns the unchanged `buildRequestContext` and `cacheKeyRequestIdentity` functions. All three graph routes import them directly; `graph-repository.js` re-exports the same function objects for compatibility. The pre-edit caller inventory comprised the repository/file/function routes (including the file in-flight key), `server-graph-repository.test.mjs` and `graph-cache-routes.test.mjs`. Those existing tests retain their old imports; `graph-request-context.test.mjs` checks both surfaces against contexts, errors and literal cache keys captured at `21e48a246210af76b302ef83f65a4645ad884e9b`.

**Remaining coupling:** file/function still import `RATE_LIMIT_PATTERN` and timeout re-exports from the repository route; function still imports `assertRevisionStillExpected` from the file route. Timeout implementation remains in `server/lib/request-work.js`. Moving those imports/helpers is a separate slice requiring its own caller inventory and review. Validation, responses, revision checks and timeout logic remain unchanged here.

**Benefit/confidence:** high confidence in simpler dependency ownership; no measured performance benefit. **Affected contracts:** requested/base/source identity, PR mode and response-cache request identity. **Gates:** `graph-request-context`, `github-context`, `cache-key`, `graph-cache-routes`, `server-graph-repository`, `server-graph-file`, `server-graph-function`, `graph-file-inflight`, `route-telemetry`, `server-bridge-import-order`, all root tests/build; structural smoke when credentials exist. Guard moved-PR 409, invalid-body status, degradation, session echo and cache hit provenance without changing expected results. **Migration/rollback:** mechanical move plus compatibility re-exports in one commit; revert that commit, no data migration. Later slices remain proposals, not authorized implementation.

### 2. Make browser startup exports explicit, then extract one panel

**Evidence:** `index.html` imports ES modules but exposes selected names to a separate Babel script through `window`; missing metadata exports caused the #27 defects. `FileLayerPanel` and `FunctionLayerPanel` already have identifiable props, session guards, renderer handles and cleanup, whereas `App` combines unrelated state lifetimes.

**Proposal:** first centralize the existing bridge registration in a module with the same global surface and loading position, keeping the inline application untouched. Inventory all bare global consumers and check dev and built startup. Only after that passes, choose one layer panel for extraction with explicit injected dependencies. Do not simultaneously replace Babel/CDNs, change framework, migrate all App state or replace workers.

**Benefit/confidence:** high confidence that named ownership makes missing exports easier to catch; medium confidence in panel extraction until its ambient React/render/global references are enumerated. No speed claim. **Contracts:** exact startup/global surface; session epoch/generation, navigation/cache, renderer disposal, complete text. **Gates:** bridge/auth-removal tests, root tests/build, `ui-smoke`, `function-layer-smoke`, `interaction-repairs-smoke`, `integration-preview-browser`, full-label and reflow suites; worker verification against both dev and built assets. **Migration/rollback:** one bridge commit, then one panel commit; preserve global aliases until all consumers move; each revertable independently. **Dependencies:** do not conflate the PR Impact functional exception with startup cleanup; preserve its behavior until separately scoped. Real browser availability is a merge gate for this future change.

### 3. Preserve the GraphIR/legacy boundary; measure specific allocations

**Evidence:** main load stores GraphIR and `repositoryGraphToViewModel(graph)` simultaneously. Primary graph rendering consumes GraphIR directly, while reports, detail cards and alternate views read legacy fields. `GraphCache.set` serializes for byte accounting and route response serialization happens separately. `stripCodeFromFnStats` and rehydration **already remove one duplicate wire payload**.

**Proposal:** keep the inverse adapter. Use temporary local profiling to attribute `metadata.functions`, graph edges, view-model arrays, JSON parse/stringify and retained objects before changing representation. If measured duplication matters, migrate one identified consumer at a time with output parity; a lazy-detail endpoint requires a separate API/cache/source-identity design.

**Benefit/confidence:** high confidence in avoiding a gratuitous compatibility rewrite; low confidence in any memory/speed saving until large-fixture measurements exist. **Contracts:** panel/export fields, function code, null churn, relationship multiplicity, source privacy and cache identity. **Gates:** repository adapter/inverse/render-model and golden tests, exact export comparison, captured Simbrain counts, alternate/dense browser gates, source/ownership and search checks. **Migration/rollback:** retain the old mapping during each consumer migration; revert individual consumer commits. **Dependency:** profiling matrix in [architecture-profiling.md](architecture-profiling.md); no sampling, label truncation or reduced coverage to improve numbers.

### 4. Evaluate isolated CodeVisualizer provisioning only after setup profiling

**Evidence:** `scripts/setup-codevisualizer-core.mjs` always resets/cleans the vendor checkout, installs the extension root dependency tree and builds `packages/core`, even when HEAD matches the pin. Both root install and build call it. The [new local baseline](architecture-profiling.md) measures repeated setup at about six seconds on this machine; it does not show production install cost or identify how much root dependency installation could safely be removed.

**Proposal:** time clone, vendor `npm ci`, TypeScript build and asset copy independently before proposing an isolated upstream workspace installation. Keep exact pin checks and dirty-vendor repair. Merely skipping setup because HEAD matches would discard an intentional integrity guarantee.

**Benefit/confidence:** high confidence that work is repeated; medium confidence that isolation is worthwhile, low confidence in a specific saving. **Contracts:** resolved core exports/WASM assets, pin integrity and raw-label provenance. **Gates:** clean install, repeated build, stale/corrupt vendor repair tests or probes, parser Unicode/range tests and full source-oracle browser labels. **Migration/rollback:** separate CodeVisualizer proposal/PR first, then a separately reviewed downstream pin/setup change; rollback to old pin and setup together. **Dependency/approval:** separate repository scope required. No dependency/configuration change in this documentation PR.

### 5. Defer larger analyzer/App extraction until one responsibility is selected

**Evidence:** analyzer consumers include Node imports, CommonJS `require(esm)`, ambient parser services and a marker-extracted classic worker. App owns independent ingestion, metadata, alternate-view and panel lifecycles. Line count alone says nothing about a safe seam.

**Candidates:** isolate preview request/cleanup state; isolate local file/ZIP ingestion without changing its parser profile; later separate pure aggregate metrics from parser-service acquisition after mapping worker dependencies. Retain the shared analyzer implementation rather than fork it by runtime.

**Benefit/confidence:** medium confidence in those cohesive responsibilities; low confidence in a broad extraction or framework rewrite. **Contracts/gates:** preview/source identity → metadata cancellation + preview/interaction suites; local ingestion → golden/exclude/local UI + worker dev/build tests; analyzer extraction → baseline/card-security/parser-provenance/import-order plus all affected adapters. **Migration/rollback:** one seam per commit behind the existing caller signature, with mechanical parity first and improvements later. **Dependencies:** startup work and product prioritization; no extra abstraction until a concrete consumer needs it.

## Functional discrepancy requiring its own decision

The legacy PR Impact dialog is reachable and still browser-side, capped at 750 files, uses a distinct adapter identity and lacks the main path's new session adoption. This is not permission to repair it under #30's documentation task. A follow-up should decide whether to route that dialog through the existing server PR contract while preserving changed-file/churn UI requirements, then test forked PR identity, moved heads, cancellation, missing credentials, overview completeness and child navigation. Do not present this as removing the already-fixed main-route cap, or silently expand #29 acceptance. No new issue, checklist completion or issue closure is performed here.

## Test/contract responsibility map

Names below refer to files under [tests/](../tests/); `*.test.mjs` belongs to `npm test`. Browser/standalone scripts do not automatically run in that command.

| Boundary / invariant | Unit and server regression owners | Additional integration / browser gate |
| --- | --- | --- |
| Context, source coordinates, GraphIR, diagnostics, cache keys | `github-context`, `source-coordinate`, `graph-ir-schema`, `graph-ir-fixtures`, `adapter-result`, `cache-key`, `navigation-events` | `scripts/verify-graph-ir-browser-import.mjs`; real pinned/fork context and navigation |
| Original analyzer and runtime parity | `analyzer-module`, `sync-with-html`, `codeflow-golden`, `baseline-snapshot`, `parser-capability-acorn`, `parser-capability-python-treesitter`, `parser-provenance-labels`, `server-bridge-import-order`, `card-analyzer-security` | `scripts/verify-worker-analysis.mjs` in dev/build; `ui-smoke.mjs` local folder; optional `verify-brain-vault.mjs` |
| Retrieval, coverage and resource ownership | `server-github-bridge`, `simbrain-overview`, `cancellation`, `concurrency-limiter`, `graph-file-inflight`, `inflight-registry`, `server-workspace`, `github-meta-cancellation` | `server-smoke.mjs`, `e2e-construction-smoke.mjs`; pinned Simbrain cancellation/recovery with counts and no sampled response |
| Server policy and diagnostics | `server-config`, `server-repo-guard`, `server-http-body`, `server-health`, `dependency-status`, `logger`, `metrics`, `route-telemetry`, `session-id` | Startup/health/readiness and real GitHub structural smoke; production checks remain separately authorized |
| Repository compatibility and rendering | `repository-graph-adapter`, `repository-graph-to-view-model`, `repository-render-model`, `blast-radius`, `graph-cache-routes`, `graph-cache-e2e` | `integration-overview-browser.mjs`, `dense-labels-browser.mjs`, `alternate-views-browser.mjs`; captured replay is distinct from live retrieval |
| File symbols and degradation | `python-symbol-index`, `pyan3-adapter`, `dot-graph`, `pyan-symbol-join`, `file-graph-adapter`, `depth-policy`, `server-graph-file`, `file-render-model` | Requests file navigation and tree-sitter-only error/degradation paths; do not infer dynamic-call completeness |
| Function identity, parser and full labels | `server-graph-function`, `function-graph-adapter`, `function-render-model`, `full-labels` | `full-labels-browser.mjs` six source-oracle cases plus multiline; `function-reflow-browser.mjs`; `function-layer-smoke.mjs` Requests |
| Sessions, transport, metadata and touch activation | `analysis-session`, `server-request`, layer-client tests, `repository-drill-down`, `node-activation`, `drill-down-capabilities-bridge`, `auth-removal-ui`, `route-state` | `interaction-repairs-smoke.mjs`, `integration-preview-browser.mjs`, browser console/page errors and latest-selection behavior |
| Alternate views | `architecture-diagram`, `graph3d-config`, repository model tests | Captured Simbrain Matrix/Tree/Cluster/Bundle/Flow fallback; broader 3D/architecture semantics remain unaccepted |

CI [test.yml](../.github/workflows/test.yml) uses Node 22.23.1 and Python 3.12, installs dependencies/pyan3, builds, runs root tests and the two structural server smokes with its authorized Actions credential. CodeQL is a separate workflow. This is not equivalent to all browser acceptance. Physical iOS/Android, pasted `/tree/ref`, optional private repository, native per-layer Back/Forward, broader 3D/architecture semantics and Garrison/OA-210 outcomes retain their evidence limits from the release records. No test expectation is weakened by this plan.
