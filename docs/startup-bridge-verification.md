# Startup bridge extraction — October 4, 2026

Related to #30, proposal 2 (startup only). Fresh isolated branch from main at **21e48a246210af76b302ef83f65a4645ad884e9b**, exactly the reviewed documentation baseline and merge of PR #35. Main advanced during publication when PR #36 merged. The single bridge commit was rebased onto **10ad01945a280bc7321419b527d2460e6fea4510**; the only conflict was the architecture-plan introduction, reconciled to retain both ownership updates. Root tests/build were rerun; no browser source changed in the rebase. Read README, architecture/next-steps and PR #35 before editing; this baseline contains no AGENTS.md, CLAUDE.md or `.agents/skills` instructions.

## Ownership and parity

`index.html` retains its inline module entry immediately before `text/babel`. That entry imports `src/browser/startupBridge.js`, the sole owner of the existing imports and `Object.assign(window, analyzer, explicitHelpers)` registration. Import order, assignment order and module function/object identities are unchanged. Explicit helpers still overwrite analyzer names on any collision; pre-existing unrelated globals survive.

| Inventory | Before | After |
| --- | --- | --- |
| All analyzer exports (including unused-by-inline exports) | 23 | Same 23 |
| Explicit render/state/adapter/client helpers | 32 | Same 32 |
| Distinct window registrations | 55 | Same 55 |
| Bare Babel consumers of those registrations | 45 | Same 45 |
| Other bare globals (platform, JavaScript built-ins, CDN libraries) | 39 | Same 39 |

The [machine-readable baseline inventory](../tests/fixtures/startup-bridge-contract.json) lists every name, explicit module owner and bare global consumer. Inventory was taken **before editing**, by parsing the Babel body with Acorn and resolving free references with eslint-scope from the already provisioned upstream development dependencies; locally declared application bindings were excluded. No dependency was added. Some exported names have no current bare caller: that is not permission to remove them. `fetchCapabilities`, `fetchBlame` and `fetchFileContentFromServer` remain direct references to their original module exports.

The replacement unit test parses the actual HTML entry, imports its named owner, observes every window write, and compares all keys and references with the independent baseline inventory plus imports from the original owners. It checks analyzer-first/explicit-last order, replacement of existing values, preservation of unrelated values, and the three historically missing helpers. Existing credential-free client/transport and auth-removal tests remain intact.

The complete Babel application body is byte-identical to the base. App and both panels remain inline. The extracted bridge body is identical except for relative import paths. `src/analyzer.js`, parser provisioning, workers, clients, renderer implementations, local ingestion and PR Impact are unchanged. Local folder/ZIP completion **still lacks generation protection**; this PR makes no contrary claim.

## Checks

Environment: Node 24.19.0 (within the declared engine range), Python 3.12 using `.venv-pyan3/bin/python`, pyan3 2.6.2, headless Chromium 153.0.8010.0 via Playwright on Linux. No physical iOS/Android device was used.

- `npm ci`: passed on retry after an initial environment-level `fatal library error, lookup self`.
- `PYTHON_BIN="$PWD/.venv-pyan3/bin/python" npm test`: **792 passed, 0 failed, 0 skipped** after rebasing onto PR #36 (774 passed before the rebase). Final tests and build ran sequentially. An initial overlapping build/test attempt invalidated vendor files while tests ran; that attempt is not the acceptance result.
- `PYTHON_BIN="$PWD/.venv-pyan3/bin/python" npm run build`: passed.
- `git diff --check`: passed.
- `ui-smoke.mjs`: passed against dev and built assets; local-folder graph, selection, alternate view, route restoration, browser Back/Forward and no unexpected console/page errors.
- `full-labels-browser.mjs`: passed against dev assets; source-oracle cases and desktop/mobile-sized geometry, no acceptance failures.
- `function-reflow-browser.mjs`: passed against dev assets, including resize/font updates and disposal (observers/listeners released, no later redraw/callback, zoom released); no console/page errors.
- `startup-bridge-browser.mjs`: dev passed all four modes (real worker completion, controlled worker error, unavailable Worker, failed source extraction), 55-key/reference parity, exact analysis result parity and disposal. Built registration/startup and all fallback/disposal checks passed, but **the real-worker-completion gate failed**. This remains an acceptance blocker.

The standalone worker probe now supplies the required `file` field in its function fixture and counts actual `done` messages. Merely constructing a Worker and then silently falling back no longer counts as worker success. These are test repairs, not production worker changes.

## Built worker blocker: reproduced on untouched baseline

A freshly built detached checkout of **21e48a246210af76b302ef83f65a4645ad884e9b** and this extraction emit byte-identical `assets/index-CJVJFSy5.js`:

```text
SHA-256 f0408bb32199015c858325d25dc8e3904702f20d9fec18d6e854ad97dd8b6cee
```

Both return the same worker error, **`buildAnalysisData is not defined`**. Both construct one worker, receive zero `done` messages, terminate it, revoke the Blob URL and produce the correct result through the existing main-thread fallback. `import.meta.url` fetches `/src/analyzer.js` in dev and the hashed bundle in built mode. Source inspection shows the minified bundle retains marker strings inside the worker bootstrap, but not the original executable core slice under its original names. The final post-rebase build retains this same bundle hash, so the browser evidence applies to byte-identical client assets. No worker or Vite repair was made to make this extraction pass.

The stronger browser gate intentionally exits nonzero on this baseline defect. Unit-test/build success does not waive it.

## Requests browser evidence boundary

There is no runtime GitHub credential in this checkout, so live server-backed Requests acceptance is **blocked**. Supplemental tests use the checked-in pinned `requests-sessions-pinned.py` fixture at `611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60`, parsed by the actual CodeVisualizer core, with **synthetic repository/file/metadata HTTP responses**. The comparison `models.py` envelope is deliberately synthetic, not an analysis of that file. These are not live captures and do not establish current GitHub retrieval, branch/tag/default-ref behavior or private access.

`function-layer-smoke.mjs` passed with those controlled responses: repository → file → function, source/ownership fallback with pinned request identity and no Authorization header, capabilities, search, complete graph geometry and in-app Back restoring cached graphs without another analysis request. The function graph contained 55 nodes and three dashed back-edges.

`integration-preview-browser.mjs` passed against **built assets with the synthetic repository fixture**: empty source, empty lines, markup/literal escaping, multiline/escapes, dismiss and supersede before the scroll deadline, and dismissal while the response was pending. No unexpected console/page errors. The existing harness’s “real pinned repository” label does not apply to this injected fixture run.

`interaction-repairs-smoke.mjs` passed against **built assets in supplemental synthetic replay mode**, all seven groups and no unexpected errors:

- Chromium touch emulation at 390×844 and 844×390: pan/pinch, hold activation, early release, drag/multitouch/pointer/navigation/orientation cancellation, selection and copy, explicit fallback and Back.
- Desktop keyboard activation and Inspector copying.
- Interrupted latest file navigation and repeated in-app Back, with the superseded file request visibly aborted.
- Controlled metadata HTTP and synchronous errors, stale ownership selection and preview dismissal.
- Local repository without a revision disables server Open file fallback.
- Controlled fatal boundary renders neutral error UI.

HTTP 502 responses in the metadata-error phase and aborted requests in cancellation phases were deliberate, expected fault injections. This is **emulation, not real-device evidence**, and none of these synthetic runs satisfy the missing live server acceptance.

Browser setup used an available Chromium binary and the environment’s HTTPS proxy; the local test launcher trusts that proxy’s certificate. `/healthz` was an explicit fixture because no backend was running. Initial browser setup used unsuitable single-process Chromium flags; reruns used ordinary multi-process Chromium. Later supplemental runs replayed exact downloaded CDN responses (including their original integrity-checked script bytes) to avoid CDN timing failures; production URLs, document scripts and parser provisioning were not changed. An earlier preview attempt timed out taking a screenshot, and a dev retry exposed a local Chromium/Vite WebSocket restriction. Successful reruns and any remaining failures are distinguished above, not silently ignored.

## Reproduce and review

Serve `npm run dev` or the built application, then run:

```sh
node tests/startup-bridge-browser.mjs http://127.0.0.1:5173/
node scripts/verify-worker-analysis.mjs http://127.0.0.1:5173/
node tests/ui-smoke.mjs http://127.0.0.1:5173/
LABEL_TEST_URL=http://127.0.0.1:5173/ node tests/full-labels-browser.mjs
node tests/function-reflow-browser.mjs http://127.0.0.1:5173/
```

Run startup/worker/UI checks again against built assets. Run the existing function-layer, interaction-repairs and integration-preview suites against a properly credentialed local server for the missing live acceptance. The strict built-worker check is expected to fail until a separately scoped worker repair is accepted. No public deployment was made. Rollback is one commit revert, with no data migration. No issue closure, panel extraction, merge or auto-merge is included.
