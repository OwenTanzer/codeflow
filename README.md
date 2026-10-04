<div align="center">

# CodeFlow

Explore repository relationships, Python file symbols and function control flow.

[Open CodeFlow](https://codeviz.moopertonic.net/) · [Documentation](docs/README.md) · [Report an issue](https://github.com/OwenTanzer/codeflow/issues)

<img src="./screenshot.png" alt="CodeFlow repository overview" width="100%"/>

</div>

## Start here

Paste `owner/repo` or a GitHub repository URL into the application, then analyze it. Select a file to inspect its source, ownership tally and relationships. Eligible Python files expose **Open file**, and eligible functions expose **Open function**; in-app Back returns to the preceding layer. Repository and file labels are complete when visible; function labels remain complete and size their shapes to their text.

The repository overview uses heuristic relationships across many source formats, including JavaScript/TypeScript, Python, Java/Kotlin and Markdown/wiki links. This does not imply full language semantics. Deeper file and function navigation is Python-only; unsupported files remain selectable for overview/source inspection. File symbols/calls and function control flow have distinct meanings and limitations.

The main server-backed repository scan has no arbitrary file-count cap. Exclusions, byte budgets, retrieval concurrency and timeouts still apply, with explicit coverage reporting. The **separate legacy PR Impact dialog** still follows a browser-side path with a 750-file sample; its behavior is not covered by the uncapped main-route claim. See the [architecture guide](docs/architecture.md#important-exception-legacy-pr-impact-dialog).

## Features and limits

- Repository graph, folder filtering, search, selection and blast-radius inspection; alternate spatial and aggregate views.
- Python file symbol/call graphs from pyan3 and tree-sitter; function control flow from pinned CodeVisualizer core.
- Source preview and commit-author ownership tally (not line-level git blame).
- Heuristic health, security, patterns, duplicate/dead-function and architecture reports; these are review aids, not correctness or security guarantees.
- Local folder/ZIP analysis, configurable excludes, Markdown/wiki-link graphs, report and visual exports.
- [CodeFlow Card](card/README.md): the same original analyzer used in a GitHub Action to generate README cards and optional PR receipts. Its workflow and parser availability differ from the hosted application.

[PR #34](https://github.com/OwenTanzer/codeflow/pull/34) records the October 4, 2026 release at `7ce7aa8020bc9bdf0c70648d175632e19f65b7d6`. The [acceptance report](docs/integration-acceptance-20261004.md) and latest comments on [#27](https://github.com/OwenTanzer/codeflow/issues/27), [#28](https://github.com/OwenTanzer/codeflow/issues/28) and [#29](https://github.com/OwenTanzer/codeflow/issues/29) distinguish local and reported production evidence. Those issues remain open for acceptance reconciliation. This README is not a fresh deployment verification.

## Where processing happens

The main GitHub repository/file/function workflow and source/ownership endpoints use the Node server's GitHub credential. There is no browser token-entry field, and the browser clients do not send Authorization headers. API routes are public and unauthenticated at the application layer; the landing page is not access control. The server applies allowlists and resource limits. Private-repository acceptance remains unverified; do not assume a deployment is a private workspace merely because its token stays server-side.

Local folder/ZIP contents are processed in the browser without uploading them in that workflow. They use the original analyzer and local source previews, with no fabricated GitHub revision or server drill-down. Loading the app, fonts, parsers and other CDN assets can still require network access: this is not a guaranteed offline package. Opening `index.html` through `file://` is unsupported.

Server GraphIR includes function snippets and analysis metadata; whole-file content is retrieved separately for preview. Server workspaces and caches have distinct lifecycles documented in the [architecture guide](docs/architecture.md). The legacy PR dialog exception is described above.

## Local setup and contribution

Use Node matching `^20.19.0 || >=22.12.0`, npm, Git and Python with venv/pip. From a fresh checkout:

```bash
git clone https://github.com/OwenTanzer/codeflow.git
cd codeflow
npm ci
npm run build
```

Installation provisions the pinned CodeVisualizer core and attempts to install pyan3 into `.venv-pyan3`. Build verifies/rebuilds that same core. These are application dependencies, not just development tooling. Exact npm resolution is in `package-lock.json`; the separate core commit is in `codevisualizer-core.lock.json` and Python pin in `requirements.txt`.

Follow [Local development in the runbook](docs/deployment.md#local-development) to start `npm start` with existing authorized server credentials and an allowlist. For UI development, run `npm run dev` in a second terminal; Vite proxies `/api`, `/healthz` and `/readyz` to the server on port 3000. Vite or `npm run preview` alone is not the GitHub analysis backend. Never put credentials in the browser, documentation, repository or test artifacts.

Run the actual root checks:

```bash
npm test
npm run build
```

When pyan3 is installed only in the checkout venv, tests need its interpreter explicitly (POSIX shell):

```bash
PYTHON_BIN="$PWD/.venv-pyan3/bin/python" npm test
```

On Windows use `.venv-pyan3/Scripts/python.exe` as `PYTHON_BIN`. Runtime config detects the local venv, but some tests default to system Python. There is no root lint/typecheck script. Choose additional server/browser gates from the [test responsibility map](docs/architecture-next-steps.md#testcontract-responsibility-map); live GitHub tests require an existing authorized credential, and browser tests require Playwright's browser installation and CDN access.

Read [the architecture guide](docs/architecture.md) before changing a boundary, then the [GraphIR contract](docs/graph-ir-contract.md) and relevant tests. Keep refactors incremental, preserve source identity, complete labels, cancellation and resource policy, and record unverified cases. Operational procedures belong in [deployment.md](docs/deployment.md); dependency updates in [codevisualizer-core-dependency.md](docs/codevisualizer-core-dependency.md).

## FAQ

**Does it need a backend?** The main GitHub workflow does. Local folder/ZIP analysis executes in the browser after the app and required assets load.

**Why can a repository overview work while drill-down does not?** Overview heuristics cover more formats than the Python-only deeper analyzers. Operator feature flags and unavailable parser dependencies can also limit a layer; diagnostics and provenance describe the result.

**Why is an analysis slow?** Retrieval, parsing, payload transfer, browser reconstruction and rendering are separate costs. The [profiling plan](docs/architecture-profiling.md) records what was actually measured; integrating three analyzers is not itself a measured cause.

**Can I share a view?** Repository share links can prefill/re-run analysis. They do not establish restoration of every selection/layer via native browser Back/Forward.

**How reliable are the graphs?** They are bounded static-analysis views. See [file limitations](docs/file-layer-limitations.md), [function semantics and renderer history](docs/function-layer-renderer.md) and the current acceptance limits; no diagram proves complete runtime behavior.
