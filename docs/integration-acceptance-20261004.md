# Codeflow PR #34: CodeVisualizer label repair acceptance

> Status note — October 4, 2026: Historical local acceptance evidence. PR #34 subsequently merged at `7ce7aa8020bc9bdf0c70648d175632e19f65b7d6`; its October 4 release update records deployment. The final sentence about no merge/deploy below describes this report’s original test boundary. [Current reading path](README.md) separates that release record from [new documentation-run verification](architecture-profiling.md).

## Exact inputs and boundary

- Codeflow PR #34's prior head was `7f6f26a3c0902f58613f4e348a8eee1844d8bebf`; its `main` base was `a4589e1f4a0b2b4e8627a7113a315812a447da44`. The tested adoption commit is `7a07e237a48b68be17e1f6d2b288e9605b078a71`, which changes only `codevisualizer-core.lock.json` from pin `974d907a5490aa96fb8e84b6723d15bc5455c658` to `ea0f56d929375794c1b9e423bede9a91328f7ed8`.
- The equivalent GitHub Git-data commit prepared for PR #34 is `0ad2571a7fb8289c601cf9e20a46012a56ffb05c`; its tree `2b66c4aaf1e3a5e9a4f42b3cbcf310fc0b2d89eb` is identical to local tested commit `7a07e237`. Runtime JSON was generated while this exact lock change was in the working tree before the local commit existed, so some evidence records prior HEAD `7f6f26a` with `dirty: true`. It does not claim the Git commit itself was already checked out during those runs.
- CodeVisualizer PR #4 merged as `ea0f56d929375794c1b9e423bede9a91328f7ed8` with parents `257f0fbe42e480baa7e481b8d312c9777a000649` and `d4a75c203400539b1afc7aeff50fbcb5128e892c`. Its tree `e71c229cfcf5810fee90e96a2bc78349923f9833` equals the independently reviewed and locally tested repair tree. GitHub records the merge author as `OwenTanzer <125096971+OwenTanzer@users.noreply.github.com>`.
- Tests ran on Windows with Node `v24.16.0`, Playwright Chromium `149.0.7827.55`, a working checkout-local pyan3 venv, a local production server on port 3000, and Vite on port 5134. Server-side GitHub calls used an existing local credential. No browser Authorization header was supplied. The follow-up report commit corrects one now-stale adapter comment; there was no Codeflow runtime-code change or weakened assertion.

## Results on the adoption commit

| Gate | Result |
| --- | --- |
| `npm ci`; `npm test` | Pass; 773 tests passed, 1 existing optional test skipped, 0 failed. Vendored core checked out and built at the exact new pin. |
| `npm run build` | Pass; setup reset and rebuilt the exact pinned core, then Vite built production assets. |
| `node tests/server-smoke.mjs` | Pass, including real public GitHub retrieval, ref resolution, allowlist, rate limit and cleanup. |
| `node tests/e2e-construction-smoke.mjs` | Pass; optional private-repository fixture unrun because none was configured. |
| `node tests/ui-smoke.mjs http://127.0.0.1:3000/` | Pass. |
| `node tests/function-layer-smoke.mjs http://127.0.0.1:3000/` | Pass: pinned Requests repository, file and function navigation, labels, search, fit and back navigation. |
| `LABEL_TEST_URL=http://127.0.0.1:5134/ node tests/full-labels-browser.mjs` | Pass: six source-oracle cases (`for`, `with`, `return`, both ternary arms, higher-order assignment) plus multiline matched exactly in GraphIR and displayed SVG text at 1680×1000 and 390×844. No lost labels, shape overflow or overlap, or edge-label overlap. |
| `node tests/function-reflow-browser.mjs http://127.0.0.1:5134/` | Pass: search/selection, resize and font reflow, idempotent disposal. |
| `node tests/interaction-repairs-smoke.mjs http://127.0.0.1:3000/ .git/acceptance-interactions` | Pass: all 9 phases, including omitted/branch/tag/SHA refs, touch emulation, interrupted navigation, stale selection, preview dismissal and fatal boundary. |
| `node tests/integration-preview-browser.mjs http://127.0.0.1:3000/ .git/acceptance-preview` | Pass: exact source markup/escapes/multiline, scroll dismissal and supersession, pending-response dismissal. |
| `node tests/integration-overview-browser.mjs http://127.0.0.1:3000/ .git/acceptance-overview` | Pass: 5 phases. Fresh live pinned Simbrain response had cache hit `false` and 1,303 nodes; retry after controlled fault used cache hit `true`. Desktop/narrow search, source, controls, cancellation and retry passed. |
| `node tests/alternate-views-browser.mjs http://127.0.0.1:3000/ .git/acceptance-alternate .git/acceptance-overview/simbrain-live-response.json` | Pass: Matrix, Tree, Cluster and Bundle; Flow passed its explicit unsupported-cycle complete-folder-list fallback. Captured source had 1,303 files, 220 folders and 4,872 unique connections. |
| `node tests/dense-labels-browser.mjs http://127.0.0.1:5134/ .git/acceptance-overview/simbrain-live-response.json .git/acceptance-dense` | Pass: 1,303 nodes; zero measured label overlap or lost text; visible at 1×. |

The captured unmodified Simbrain response is 20,778,239 bytes with SHA-256 `8f8b0b5ae24d2f02029f7af14d683ca3754db4f06a00dc6ed28deea48c60e9ce`. Runtime JSON and screenshots remain under this checkout's `.git/acceptance-*` and `.git/run2-*` paths; they are not committed. The desktop and narrow function screenshots, dense graph, and mobile source-preview screenshot were visually inspected against the structured source-oracle checks. The direct source-browser checks report exact text for all seven cases at both viewports; the 55-node Requests function had no lost displayed labels.

## Review and remaining limits

The upstream repair received independent read-only review of its exact tested tree with no findings. Independent read-only review of this downstream adoption diff and local evidence found no remaining issue: the six raw-label values and displayed browser text match the independent source oracles, and the Simbrain capture hash and gate summaries match this report. That reviewer did not independently verify shell command exit logs or the prepared GitHub Git-data commit; those were checked by the implementer. Remote PR checks are verified after publication. No Codeflow branch was merged or deployed.

The optional private-repository fixture remains unrun. Touch checks use Chromium emulation, not physical iOS/Android. The overview ref test injects its SHA at the existing bridge seam and does not prove pasted `/tree/ref` URLs. Preview content and font-delay cases include controlled fixtures; the Simbrain alternate and dense tests replay a captured real response. Flow's cycle fallback does not establish a rendered Sankey diagram. Broader 3D camera legibility and architecture semantics remain outside these checks. The CodeVisualizer extension runner previously discovered zero extension tests locally; that green exit is not coverage evidence.
