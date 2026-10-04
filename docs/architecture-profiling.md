# Architecture profiling and verification

Documentation task for #30, October 4, 2026. Source baseline and freshly fetched main:
`7ce7aa8020bc9bdf0c70648d175632e19f65b7d6`. Isolated branch:
`docs/30-architecture-20261004`; initial working tree clean. No applicable
ancestor/repository `AGENTS.md`, `CLAUDE.md` or `.agents/skills` was present in
this checkout. Latest bodies/comments of #27–30 and PR #34 were read before edits.
No runtime, schema, test expectation, dependency or deployment configuration changes
are authorized by this task.

## Measurement environment

Linux x86_64, kernel 6.18.44, glibc 2.39; Node v24.19.0, npm 11.9.0,
Python 3.12.14; 9 logical CPUs reported (shared runtime, not a dedicated benchmark
machine). `npm ci` resolved Vite 8.1.5, Playwright 1.61.1, Acorn 8.17.0,
web-tree-sitter 0.20.8, tree-sitter-wasms 0.1.13 and ts-graphviz 3.0.7.
CodeVisualizer git pin is `ea0f56d929375794c1b9e423bede9a91328f7ed8`, core
package version 0.1.0 with its separate tree-sitter dependency; pyan3 2.6.2
installed in `.venv-pyan3`. CI uses Node 22.23.1/Python 3.12; Railpack declares
Python 3.13. These environments are not identical.

No `GITHUB_TOKEN`/`GH_TOKEN` was present and `gh` was unavailable. Public git
cloning and dependency installation worked; that does not supply a credential
to the application's server. No credential was copied from another conversation
or placed in artifacts. No hosted benchmark, production request or load test ran.

## New local observations

### Setup/build (one sample each)

Measured with Python `time.perf_counter()` around `subprocess.run`, redirecting
stdout/stderr to temporary local logs. Times include process startup. Fresh clone
had no `node_modules`, `.vendor` or pyan venv; package-manager/OS cache state was
not controlled, so “clean checkout” is not “cold machine”.

| Command / initial state | Wall time | Outcome |
| --- | ---: | --- |
| `npm ci`, clean checkout | 45.264 s | Passed, including vendored core and pyan3 installation |
| `npm run setup:codevisualizer`, existing pin/dependencies | 5.960 s | Passed; reset/clean, root vendor install and core rebuild still executed |
| `npm run build`, immediately after setup | 5.342 s | Passed; includes another core setup, build-info and Vite |

Vite's own first build log reported 295 ms, 33 transformed modules,
414.13 kB HTML and 179.16 kB JS (reported build sizes, not runtime memory).
No separate clone/install/compiler phase timer was injected into setup; do not
attribute its entire wall time to any one phase. Three commands are not a
statistical speed comparison. Repeated build after documentation is a validation
check, not a new comparable performance sample.

### Local pinned-source pipeline (three sequential samples)

Fixture: committed `tests/fixtures/python-symbols/requests-sessions-pinned.py`,
34,072 UTF-8 bytes, SHA-256
`3d2089736ced93b2b405624a943f866d22652b17df06a85eb010f86272fc3e7d`.
Identity: `psf/requests@611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60`,
`src/requests/sessions.py`, `SessionRedirectMixin.resolve_redirects`.
This used the committed fixture, **not freshly retrieved GitHub source**.

A temporary Node harness invoked production functions without HTTP or network,
using `performance.now()` around each await. It ran sequentially in one process:
first sample includes lazy initialization; samples 2–3 reuse initialized modules
but still rerun parsing/subprocesses. Other checks shared the host, so timings
are exploratory, not isolated performance claims. No graph cache lookup was used
to skip work; a fresh cache measured insertion each sample. pyan timeout was
30,000 ms and output budget 10 MiB in the harness; no service policy was changed.
File depth policy was not applied: this measures the full file adapter output.

| Phase (ms) | Sample 1 | Sample 2 | Sample 3 |
| --- | ---: | ---: | ---: |
| pyan workspace/staging/subprocess/DOT/cleanup combined | 189.568 | 210.142 | 224.162 |
| Tree-sitter symbol indexing | 37.783 | 10.204 | 7.072 |
| Symbol join | 1.069 | 0.257 | 0.137 |
| File adapter | 2.668 | 0.566 | 0.447 |
| Core initialization call | 14.261 | 3.242 | 2.930 |
| CodeVisualizer function parse | 38.809 | 10.383 | 12.841 |
| Function adapter | 18.676 | 4.369 | 2.447 |
| Additional explicit function GraphIR validation | 0.647 | 0.161 | 0.120 |
| Function GraphIR serialization | 0.341 | 0.147 | 0.112 |
| Cache insertion including its serialization accounting | 0.464 | 0.105 | 0.100 |

All samples produced 40 file nodes, 55 function nodes and a 42,380-byte function
graph/cache accounting size under the harness's `profile-core@1` provenance.
This is graph JSON, not the production AdapterResult response. Adapter timing
already includes its own construction/validation; the explicit validation row
is an additional probe, not a disjoint production phase. The pyan combined row
cannot be read as pure Python CPU time.

Process RSS (resident set size) after samples was 104,054,784 / 108,470,272 /
110,587,904 bytes; heap used was 16,950,520 / 16,586,320 / 22,326,504 bytes.
These are post-sample snapshots of the whole Node harness, **not peak memory**,
not incremental retained graph memory, not Python child peaks and not browser/GPU
memory. Garbage collection was not controlled. They establish no memory leak.

### Reproduce the local probe

After documented setup, run from the repository root. Save the following as a
temporary `.mjs` outside tracked source and run `node /path/to/probe.mjs`.
It uses the POSIX venv interpreter; adjust only that path for Windows.
Do not run it concurrently with other benchmarks if comparable timings matter.
The initial development attempt imported the offset helper from the barrel and
failed; the corrected direct import below is the measured harness's behavior.

```javascript
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const root = pathToFileURL(process.cwd() + '/');
const imp = p => import(new URL(p,root));
const { indexPythonSymbols } = await imp('server/lib/pythonSymbolIndex.js');
const { WorkspaceManager } = await imp('server/lib/workspace.js');
const { runSharedPyan3Analysis } = await imp('server/routes/graph-file.js');
const { joinPyanToSymbols } = await imp('server/lib/pyanSymbolJoin.js');
const { adaptFileAnalysis } = await imp('src/adapters/fileGraphAdapter.js');
const { adaptFunctionAnalysis } = await imp('src/adapters/functionGraphAdapter.js');
const { normalizeContext,validateGraphIR } = await imp('src/graph-ir/index.js');
const { lineColumnToCodeUnitOffset } = await imp('src/graph-ir/codeUnitOffset.js');
const { GraphCache } = await imp('server/lib/graph-cache.js');
const core = await imp('node_modules/@codevisualizer/core/dist/index.js');
const source=readFileSync(new URL('tests/fixtures/python-symbols/requests-sessions-pinned.py',root),'utf8');
const path='src/requests/sessions.py';
const context=normalizeContext({owner:'psf',repo:'requests',resolvedSha:'611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60'});
const temp = mkdtempSync(join(tmpdir(), 'codeflow-profile-'));
const wm=new WorkspaceManager(temp);await wm.ensureRoot();
const records=[];
for(let i=0;i<3;i++){
 const row={sample:i+1};
 async function time(k,f){const t=performance.now();const v=await f();row[k]=+(performance.now()-t).toFixed(3);return v;}
 const p=await time('pyanStageRunDotCleanupMs',()=>runSharedPyan3Analysis({pythonBin:new URL('.venv-pyan3/bin/python',root).pathname,workspaceManager:wm,files:[{path,content:source}],timeoutMs:30000,maxBuffer:10*1024*1024}));
 if(p.failedCategory)throw Error(p.warnings.join(';'));
 const {entries}=await time('symbolIndexMs',()=>indexPythonSymbols({path,content:source}));
 const joined=await time('symbolJoinMs',()=>joinPyanToSymbols({pyanNodes:p.pyanNodes,pyanEdges:p.pyanEdges,symbolEntries:entries}));
 const fg=await time('fileAdapterMs',()=>adaptFileAnalysis({context,requestPath:path,joined,analyzer:{name:'profile-pyan',version:'1'}}));
 const entry=entries.find(e=>e.symbolPath.join('.')==='SessionRedirectMixin.resolve_redirects');
 await time('coreInitMs',()=>core.initPythonLanguageService());
 const ir=await time('coreParseMs',()=>core.analyzePythonFunction(source,{startByte:lineColumnToCodeUnitOffset(source,entry.startLine,entry.startColumn),endByte:lineColumnToCodeUnitOffset(source,entry.endLine,entry.endColumn)}));
 const g=await time('functionAdapterMs',()=>adaptFunctionAnalysis({context,entrySymbol:entry,source,flowchartIR:ir,analyzer:{name:'profile-core',version:'1'}}));
 await time('validateMs',()=>validateGraphIR(g));
 const json=await time('serializeMs',()=>JSON.stringify(g));row.functionGraphBytes=Buffer.byteLength(json);row.fileNodes=fg.nodes.length;row.functionNodes=g.nodes.length;
 const cache=new GraphCache({maxItems:200,maxBytes:268435456,ttlMs:3600000,enabled:true});
 await time('cacheSetMs',()=>cache.set('profile',g));row.cacheBytes=cache.totalBytes;
 row.processMemory=process.memoryUsage();records.push(row);
}
console.log(JSON.stringify({method:'Sequential same-process local source microbenchmark; no HTTP/retrieval/browser; first sample includes lazy initialization',fixtureSha256:createHash('sha256').update(source).digest('hex'),sourceBytes:Buffer.byteLength(source),records},null,2));

rmSync(temp, {recursive:true, force:true});
```

## Historical Simbrain evidence — not rerun here

[PR #34](https://github.com/OwenTanzer/codeflow/pull/34) and the
[latest #29 release comment](https://github.com/OwenTanzer/codeflow/issues/29#issuecomment-5982499768)
record `simbrain/simbrain@9f630ae2d7304e316dc13b27399787251a5953aa`:
2,372 blobs, 1,304 selected, 1,303 analyzed, 1,068 excluded and one oversized CSV;
8,993,604 analyzed bytes. Isolated local cold/warm times were 33.539/0.654 s,
with 1,305/1 upstream requests and about 20.78 MB responses. PR #34 attributes
the retrieval benchmark to `817241f227b6302cb3a2fb5be6cac24ef7725be2`.
The [later acceptance report](integration-acceptance-20261004.md) records a
20,778,239-byte captured response and its hash at the adoption tree.

These are different historical observations; do not assign them this run's
Linux environment or combine them into a newly measured average. The release
records deployment at `7ce7aa8`; no live deployment verification was performed
here. Large payloads motivate attribution, not a conclusion that adapters or
three analysis origins cause the slowness.

## Reproducible next profiling pass

Use an isolated local checkout/server and existing authorized credentials only.
Record exact app/core/fixture SHAs, OS/CPU/runtime/browser versions, viewport,
font readiness, all resource limits/concurrency/cache settings, exclusion list,
cache state and sample count. Retain unmodified responses with hashes and verify
coverage/text oracles before interpreting timings. Keep secrets and private
source out of logs/artifacts. Do not change production or increase budgets.

| Phase | Existing evidence / bounded collection method | Missing now |
| --- | --- | --- |
| Setup/build | One fresh disposable checkout; time setup/build separately, then three repeated runs. In a temporary local wrapper measure clone, vendor install, core build and Vite individually; preserve integrity checks. | Independent phase breakdown, repeated clean samples, deployment image costs |
| Ref/tree/blob retrieval | One Requests chain cold/warm pair. Use request/session logs and `fetchAndAnalyzeRepo` measurements (`retrievalMs`, upstream requests, content bytes); separately time ref resolution/tree/blob phases locally. | All fresh authenticated retrieval measurements |
| Simbrain overview | At most one cold and one warm pinned scan, sequentially, after confirming existing rate-limit headroom. Server restart supplies cold graph cache. Stop on access/rate limit; do not repeat 1,305-request scans for statistical cosmetics. | Current server phases, response and cache occupancy |
| Original extraction/aggregate | Temporary timers around `Parser.extract` batches and `buildAnalysisData`, preserving every eligible file; record capability/provenance and counts. | Repository parsing versus aggregate cost |
| File/function | Time workspace/staging, pyan subprocess, DOT parse, index/join/depth and core parse independently; compare first and repeated local/HTTP requests. File/function cache hits still retrieve source; label each cache correctly. | Subphase pyan breakdown, HTTP timings, cache-hit retrieval contribution |
| Adapt/validate/serialize/cache | Existing route serialization log and GraphCache byte accounting; temporary timers around each adapter/envelope/cache set and field-wise JSON sizes. Do not double count adapter-internal validation. | Large-fixture attribution; retained heap versus serialized size |
| Browser decode/reconstruction | Capture/replay one real response separately from live retrieval. DevTools timing/temporary performance marks around `res.json`, inverse mapper and render model; take heap snapshots before/after adoption and after reset. | Browser JSON/model/heap measurements |
| Layout/paint/interaction | Performance trace from adoption through stable layout, then a fixed search/select/pan/zoom sequence at desktop/narrow viewports. Record long tasks, frame timings, text geometry, font load and responsive controls. Three replay samples can avoid extra GitHub calls. | Layout/paint/interaction latency, browser and GPU memory |
| Cancellation/drain/recovery | Existing deterministic cancellation/inflight/concurrency tests first. On the local server use at most two concurrent Requests operations under unchanged limits; cancel during retrieval/pyan, record abort → final worker settlement → slot release, then recover with one small request. | Measured drain latency and bounded real recovery; synchronous parse preemption is unsupported |

Use cold/warm labels per cache: OS/package cache, process parser initialization,
server graph cache and browser breadcrumb Map are not the same cache. Report
individual samples/ranges at small n, not unjustified percentiles. Temporary
instrumentation stays outside the PR; production instrumentation or new detail
APIs require separate approval. Never truncate labels, hide files, sample the
graph, weaken assertions or loosen limits to manufacture faster results.

## Verification ledger for this documentation branch

| Status | Check | Evidence / limit |
| --- | --- | --- |
| Passed | Fresh `npm ci`; repeated `setup:codevisualizer`; `npm run build` | Exact core pin built; pyan3 installed. Final build rerun after documentation edits. |
| Failed, recovered | Initial unconfigured `npm test` | 738 pass, 36 fail: system Python lacked pyan3. No test/runtime patch; corrected interpreter. |
| Passed | `PYTHON_BIN="$PWD/.venv-pyan3/bin/python" npm test` | 774 pass, 0 fail, 0 skipped. Distinct from historical 773 pass / 1 skip. |
| Passed | `node examples/minimal-graphir-adapter.mjs` | Contract example runs locally. |
| Passed | Local pinned-source profiling harness | Three samples above; initial harness import error corrected before measurements. |
| Blocked | `node tests/server-smoke.mjs`; `node tests/e2e-construction-smoke.mjs` | Both exit before tests: no `GITHUB_TOKEN` or authenticated `gh`. Optional private fixture also unconfigured. |
| Blocked | Browser execution | Playwright Chromium missing; standard `npx playwright install chromium` failed with truncated/non-ZIP download. No alternate browser claimed equivalent. |
| Not run | Browser suites and worker dev/build verification | Browser prerequisite unavailable; prior release evidence preserved without relabeling it as new. |
| Not run | Live Requests/Simbrain retrieval, production, physical-device and GPU profiling | Credentials/environment/scope limits above. |

Documentation link/symbol checks, Mermaid syntax parsing, comment-only source
comparison and final remote commit/check status are recorded in the draft PR.
Mermaid syntax validation does not establish visual layout in every viewer.
