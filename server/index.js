// Server entry point — MOO-67 Commits 5-6.
//
// Establishes the durable application shell: config validated at startup
// (fail fast, not on first request), health/readiness endpoints (public —
// Railway's own monitoring needs to reach these), namespaced /api/*
// analysis endpoints (public, per-IP rate limited only — no auth gate;
// see the removal note in server/lib/config.js), structured per-request
// logging, and the request-scoped workspace abstraction later analyzers
// (MOO-70/71) will build on.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { loadConfig, ConfigError } from './lib/config.js';
import { log, configureLogger, generateRequestId } from './lib/logger.js';
import { WorkspaceManager } from './lib/workspace.js';
import { createStaticHandler } from './lib/static.js';
import { createHealthHandler, createReadinessHandler, readBuildInfo } from './lib/health.js';
import { clientKey } from './lib/client-ip.js';
import { RateLimiter } from './lib/rate-limit.js';
import { GraphCache } from './lib/graph-cache.js';
import { Metrics } from './lib/metrics.js';
import { InFlightRegistry } from './lib/inflight-registry.js';
import { ConcurrencyLimiter } from './lib/concurrency-limiter.js';
import { createAnalyzeHandler } from './routes/analyze.js';
import { createAnalyzeRepoHandler } from './routes/analyze-repo.js';
import { createGraphRepositoryHandler } from './routes/graph-repository.js';
import { createGraphFileHandler } from './routes/graph-file.js';
import { createGraphFunctionHandler } from './routes/graph-function.js';
import { createGithubBlameHandler, createGithubFileContentHandler } from './routes/github-meta.js';
import { PYTHON_TREE_SITTER_CAPABLE } from './lib/github-analyzer-bridge.js';
import { makeStatus, refreshDependencyStatuses } from './lib/dependency-status.js';
import { initPythonLanguageService } from '@codevisualizer/core';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..');

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * MOO-72 Commit 4 PR review: a 429 with no `Retry-After` header left the
 * client's retryAfterMs-based Retry gating (src/state/serverRequest.js)
 * unable to actually engage for this, the one real application-generated
 * 429 -- retryAfterMs stayed null and Retry re-enabled immediately,
 * exactly the bug the client-side fix was meant to prevent. Sets the
 * header as a side effect only when rate-limited, rounded UP to whole
 * seconds (Retry-After's own spec is an integer number of seconds; never
 * round down, which could let a client retry a moment before the window
 * actually resets).
 * @param {import('./lib/rate-limit.js').RateLimiter} rateLimiter
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {{allowed: boolean, remaining: number, retryAfterMs: number|null}}
 */
function checkRateLimit(rateLimiter, req, res) {
  const result = rateLimiter.check(clientKey(req));
  if (!result.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
  }
  return result;
}

async function main() {
  let config;
  try {
    config = loadConfig({ repoRoot });
  } catch (err) {
    if (err instanceof ConfigError) {
      // Actionable, not a stack trace: this is meant to be read by whoever
      // just ran `npm start`/deployed to Railway.
      //
      // exitCode, not exit(1): an immediate process.exit() can truncate a
      // write still sitting in a pipe's buffer (Railway's log collector
      // reads stdout/stderr through a pipe, which is exactly the case
      // Node's own docs warn can drop output under exit()). Setting
      // exitCode and returning lets the event loop drain -- with nothing
      // else keeping it alive at this point, the process exits on its own
      // once that write actually flushes.
      process.stderr.write('[codeflow-server] ' + err.message + '\n');
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // Configured immediately once config exists -- everything logged from
  // this point on is level-gated and redacted (GITHUB_TOKEN scrubbed
  // verbatim wherever it'd appear in a logged string, plus the generic
  // token-shape patterns in logger.js). The one thing that can never go
  // through this path is the loadConfig failure above: there is no config
  // yet at that point to redact with, so it stays a plain stderr write.
  configureLogger({ level: config.logLevel, secrets: [config.githubToken] });

  const workspaceManager = new WorkspaceManager(config.workspaceRoot);
  try {
    await workspaceManager.ensureRoot();
  } catch (err) {
    log('error', 'workspace root is not writable', { workspaceRoot: config.workspaceRoot, errorMessage: err.message });
    // exitCode, not exit(1) -- see the ConfigError branch above for why.
    process.exitCode = 1;
    return;
  }

  // MOO-72 Commit 6: process-restart cleanup -- removes any *other*
  // instance's orphaned workspace directories left behind by a crashed
  // prior process (confirmed not-alive via its own lock file's PID, never
  // an overlapping still-running instance). Never fatal -- a failed sweep
  // means potentially-private source lingers on disk longer than it
  // should, which is worth a loud log, not a startup abort (the server is
  // otherwise fully able to serve traffic).
  {
    const sweepResult = await workspaceManager.sweepStaleWorkspaces();
    if (sweepResult.skipped) {
      log('warn', 'workspace startup sweep skipped', { reason: sweepResult.skipped, workspaceRoot: config.workspaceRoot });
    } else {
      log('info', 'workspace startup sweep complete', { removed: sweepResult.removed, failed: sweepResult.failed });
      if (sweepResult.failed > 0) {
        log('error', 'workspace startup sweep left stale, potentially-private workspace(s) behind', { failed: sweepResult.failed });
      }
    }
  }

  // MOO-70 Commit 7/9: check pyan3 availability once at startup so it's
  // visible in the logs immediately, rather than only discovered on the
  // first /api/graph/file request. PR review finding: this previously
  // called process.exit(1) on failure, which took down the *entire*
  // server -- including the repository layer and the static app, which
  // have no dependency on pyan3 at all -- directly contradicting this
  // ticket's own "keep the repository layer operational when pyan3
  // fails" requirement. Never fatal now: a missing/broken pyan3 install
  // is logged as a warning and the server continues. Each individual
  // /api/graph/file request already degrades gracefully when pyan3 is
  // unavailable (server/routes/graph-file.js's runPyan3ForFile returns a
  // tree-sitter-only graph rather than throwing) -- that same per-request
  // resilience is exactly what covers a totally-missing pyan3 install
  // too, so no separate "capability flag" plumbing is needed here.
  //
  // MOO-72 Commit 5: pyan3Status/pythonRuntimeStatus/githubReachableStatus
  // are the normalized {ok,detail,version,checkedAt} shape (dependency-status.js)
  // instead of bare booleans, so /readyz can report real detail. All three
  // are produced by one
  // refreshDependencyStatuses() call, reused verbatim by the periodic
  // refresh below -- no separate/duplicated startup-only check logic.
  let { pyan3Status, pythonRuntimeStatus, githubReachableStatus } = await refreshDependencyStatuses({
    pythonBin: config.pythonBin,
    githubToken: config.githubToken,
  });
  if (!pyan3Status.ok) {
    log('warn', 'pyan3 unavailable at startup -- /api/graph/file will run in tree-sitter-only (degraded) mode until this is fixed', {
      errorMessage: pyan3Status.detail,
    });
  }
  if (!githubReachableStatus.ok) {
    log('warn', 'GitHub API unreachable or the configured token was rejected at startup -- GitHub-backed analysis will fail until this is fixed', {
      errorMessage: githubReachableStatus.detail,
    });
  }

  // MOO-71 Commit 5: mirrors the pyan3 startup-check pattern above
  // exactly. Unlike pyan3, there's no per-request degraded fallback for
  // the function layer (no fallback analyzer exists) -- graph-function.js
  // uses this flag to fail clearly before even attempting a GitHub
  // fetch, rather than pretending to proceed.
  //
  // MOO-72 Commit 5: codeVisualizerAvailable (this bare boolean) is left
  // completely untouched -- it's still what createGraphFunctionHandler
  // gates real requests on below. codeVisualizerStatus is a SEPARATE,
  // parallel object purely for /readyz's richer reporting; both are set
  // from the same check, at the same time, but the boolean's contract
  // (and every existing consumer of it) is unchanged. codeVisualizerStatus
  // is never refreshed after startup -- see health.js's own comment on why
  // (the vendored @codevisualizer/core package's parser-init memoization
  // isn't something this codebase controls).
  let codeVisualizerAvailable = true;
  let codeVisualizerStatus = makeStatus(true, null);
  try {
    await initPythonLanguageService();
  } catch (err) {
    codeVisualizerAvailable = false;
    codeVisualizerStatus = makeStatus(false, err.message);
    log('warn', 'CodeVisualizer core unavailable at startup -- /api/graph/function will be unavailable until this is fixed', {
      errorMessage: err.message,
    });
  }

  const rateLimiter = new RateLimiter(config.rateLimitPerMinute);
  const rateLimitSweep = setInterval(() => rateLimiter.sweep(), 60_000);
  rateLimitSweep.unref();

  // MOO-72 Commit 2: one shared cache across all three graph layers -- the
  // key format (src/graph-ir/cacheKey.js) already namespaces layers by
  // analyzer name/version and coordinate, so a single store is correct and
  // lets one global memory budget cover all of them.
  //
  // Process-local by design: every entry is lost on restart or redeploy,
  // and nothing is shared between replicas. That is only sound because this
  // is a single-instance Railway deployment; running more than one replica
  // would give each its own independent cache (correct, but with a lower
  // hit rate), and a shared store would be a separate piece of work.
  const graphCache = new GraphCache({
    maxItems: config.cacheMaxItems,
    maxBytes: config.cacheMaxBytes,
    ttlMs: config.cacheTtlMs,
    enabled: config.cacheEnabled,
  });

  // MOO-72 Commit 5: a dedicated, tiny, isolated GraphCache instance purely
  // for /readyz's cacheStorage self-test -- PR review finding: round-
  // tripping against the LIVE graphCache above would perturb real LRU
  // order, consume capacity, and risk a key collision on every /readyz hit.
  // Always constructed enabled -- whether the *live* cache is disabled by
  // configuration is a separate question health.js answers by reading
  // config.cacheEnabled directly, before ever touching this instance.
  const healthCheckCache = new GraphCache({ maxItems: 1, maxBytes: 1024, ttlMs: 60_000, enabled: true });

  // MOO-72 Commit 3: one shared counter store across all three graph
  // layers, same process-local/cumulative-since-start lifetime as
  // graphCache above. A required constructor dependency for every route
  // handler below (not an optional no-op default) -- a silent default
  // would hide exactly the kind of production wiring mistake this is
  // meant to prevent.
  const metrics = new Metrics();

  // MOO-72 Commit 4: de-duplicates concurrent pyan3 subprocess work for
  // the same file/package@revision. Scoped to the file layer only -- the
  // function layer's CodeVisualizer analysis is synchronous/CPU-bound, so
  // it blocks the event loop while running and never has real concurrent
  // in-flight work to collapse (see graph-function.js's docs for why it
  // isn't wired here too).
  const fileInflightRegistry = new InFlightRegistry();

  // MOO-72 Commit 8: server-wide cap on concurrent expensive analyses,
  // shared across all five analysis routes -- see server/lib/concurrency-limiter.js
  // for why this exists (neither the rate limiter nor the in-flight
  // registry above bound concurrent *distinct* work) and config.js's
  // MAX_CONCURRENT_ANALYSES comment for how the default was derived.
  const concurrencyLimiter = new ConcurrencyLimiter(config.maxConcurrentAnalyses);

  // MOO-72 Commit 5: folded into this existing interval rather than adding
  // a second timer -- one fewer moving piece, same 5-minute cadence
  // already established here. Guarded by `refreshInFlight` so an overlap
  // (a check hanging past 5 minutes) is skipped rather than allowed to run
  // concurrently with itself -- cheap insurance even though every
  // individual check's own timeout (10s) is far shorter than the interval.
  let refreshInFlight = false;
  const metricsSummaryInterval = setInterval(() => {
    // Logged at 'info' -- LOG_LEVEL=warn or error suppresses this line,
    // same as any other info log. That's expected, not a sign metrics
    // collection itself is broken.
    log('info', 'metrics summary', metrics.snapshot());

    if (refreshInFlight) {
      log('warn', 'dependency status refresh skipped -- previous refresh still in flight');
      return;
    }
    refreshInFlight = true;
    refreshDependencyStatuses({ pythonBin: config.pythonBin, githubToken: config.githubToken })
      .then((next) => {
        pyan3Status = next.pyan3Status;
        pythonRuntimeStatus = next.pythonRuntimeStatus;
        githubReachableStatus = next.githubReachableStatus;
      })
      .catch((err) => {
        // refreshDependencyStatuses already isolates each individual
        // check's own failure into its own status object -- reaching this
        // catch means something broke in the refresh plumbing itself, not
        // a dependency being down. Never let that take down the interval.
        log('error', 'dependency status refresh failed unexpectedly', { errorMessage: err && err.message });
      })
      .finally(() => {
        refreshInFlight = false;
      });
  }, 5 * 60 * 1000);
  metricsSummaryInterval.unref();

  const handleStatic = createStaticHandler(config.distDir);
  const buildInfo = readBuildInfo(repoRoot);
  log('info', 'build info', buildInfo);
  const handleHealth = createHealthHandler({ config, buildInfo });
  const handleReadiness = createReadinessHandler({
    config,
    healthCheckCache,
    getPyan3Status: () => pyan3Status,
    getPythonRuntimeStatus: () => pythonRuntimeStatus,
    getCodeVisualizerStatus: () => codeVisualizerStatus,
    getGithubReachableStatus: () => githubReachableStatus,
    pythonTreeSitterCapable: PYTHON_TREE_SITTER_CAPABLE,
  });
  const handleAnalyze = createAnalyzeHandler({ config, workspaceManager, concurrencyLimiter });
  const handleAnalyzeRepo = createAnalyzeRepoHandler({ config, concurrencyLimiter });
  const handleGraphRepository = createGraphRepositoryHandler({ config, cache: graphCache, metrics, concurrencyLimiter });
  const handleGraphFile = createGraphFileHandler({
    config,
    workspaceManager,
    cache: graphCache,
    metrics,
    inflightRegistry: fileInflightRegistry,
    concurrencyLimiter,
  });
  const handleGraphFunction = createGraphFunctionHandler({
    config,
    getCodeVisualizerAvailable: () => codeVisualizerAvailable,
    cache: graphCache,
    metrics,
    concurrencyLimiter,
  });
  // MOO-86: server-side replacements for the legacy client-side blame/
  // file-preview-fallback features -- see routes/github-meta.js's own
  // header comment for why these are deliberately lighter-weight than the
  // three graph handlers above (no cache/concurrency-limiter/metrics).
  const handleGithubBlame = createGithubBlameHandler({ config });
  const handleGithubFileContent = createGithubFileContentHandler({ config });

  const server = createServer(async (req, res) => {
    const requestId = generateRequestId();
    const start = Date.now();
    res.setHeader('X-Request-Id', requestId);

    const url = new URL(req.url || '/', 'http://localhost');
    const isApiRoute = url.pathname.startsWith('/api/');

    try {
      if (url.pathname === '/healthz') {
        await handleHealth(req, res);
      } else if (url.pathname === '/readyz') {
        await handleReadiness(req, res);
      } else if (isApiRoute && !checkRateLimit(rateLimiter, req, res).allowed) {
        log('warn', 'rejected rate-limited request', { requestId, path: url.pathname });
        sendJson(res, 429, { error: 'Rate limit exceeded, try again shortly' });
      } else if (url.pathname === '/api/capabilities' && req.method === 'GET') {
        // MOO-72 Commit 8: the client-visible half of the feature flags --
        // the UI fetches this at startup to hide/disable affordances for a
        // disabled layer, rather than leaving a still-clickable control
        // that just 503s.
        sendJson(res, 200, {
          fileLayerEnabled: config.fileLayerEnabled,
          functionLayerEnabled: config.functionLayerEnabled,
          degradedAnalysisEnabled: config.degradedAnalysisEnabled,
          experimentalInteractionsEnabled: config.experimentalInteractionsEnabled,
        });
      } else if (url.pathname === '/api/analyze' && req.method === 'POST') {
        await handleAnalyze(req, res, requestId);
      } else if (url.pathname === '/api/analyze-repo' && req.method === 'POST') {
        await handleAnalyzeRepo(req, res, requestId);
      } else if (url.pathname === '/api/graph/repository' && req.method === 'POST') {
        await handleGraphRepository(req, res, requestId);
      } else if (url.pathname === '/api/graph/file' && req.method === 'POST') {
        if (!config.fileLayerEnabled) {
          sendJson(res, 503, { error: 'The file layer is currently disabled', retryable: false, requestId });
        } else {
          await handleGraphFile(req, res, requestId);
        }
      } else if (url.pathname === '/api/graph/function' && req.method === 'POST') {
        if (!config.functionLayerEnabled) {
          sendJson(res, 503, { error: 'The function layer is currently disabled', retryable: false, requestId });
        } else {
          await handleGraphFunction(req, res, requestId);
        }
      } else if (url.pathname === '/api/github/blame' && req.method === 'POST') {
        await handleGithubBlame(req, res, requestId);
      } else if (url.pathname === '/api/github/file-content' && req.method === 'POST') {
        await handleGithubFileContent(req, res, requestId);
      } else if (isApiRoute) {
        sendJson(res, 404, { error: 'Not found' });
      } else {
        await handleStatic(req, res);
      }
    } catch (err) {
      log('error', 'unhandled request error', { requestId, errorMessage: err && err.message });
      if (!res.headersSent) res.writeHead(500);
      res.end('Internal server error');
    } finally {
      log('info', 'request', {
        requestId,
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        durationMs: Date.now() - start,
      });
    }
  });

  server.listen(config.port, () => {
    log('info', 'server started', {
      port: config.port,
      distDir: config.distDir,
      workspaceRoot: config.workspaceRoot,
      nodeEnv: config.nodeEnv,
      nodeVersion: process.version,
      allowedRepos: config.allowedRepos.length,
      allowedOwners: config.allowedOwners.length,
      rateLimitPerMinute: config.rateLimitPerMinute,
      pyan3Available: pyan3Status.ok,
      pythonRuntimeAvailable: pythonRuntimeStatus.ok,
      codeVisualizerAvailable,
      githubReachable: githubReachableStatus.ok,
      pythonTreeSitterCapable: PYTHON_TREE_SITTER_CAPABLE,
      cacheEnabled: config.cacheEnabled,
      cacheMaxItems: config.cacheMaxItems,
      cacheMaxBytes: config.cacheMaxBytes,
      cacheTtlMs: config.cacheTtlMs,
      // Stated explicitly in the startup line rather than left to docs: an
      // operator debugging a stale or missing result needs to know the cache
      // does not survive a restart and is not shared across replicas.
      cacheScope: 'process-local (cleared on restart/deploy, not shared across replicas)',
      logLevel: config.logLevel,
    });
  });
}

main().catch((err) => {
  // PR review finding: by the time anything can bubble out to this
  // catch-all, configureLogger() (called immediately after loadConfig
  // succeeds, near the top of main()) has always already run -- the only
  // failure that can happen before that point is loadConfig's own
  // ConfigError, which is caught and exits inline, never reaching here.
  // So this can safely go through the structured/redacted logger rather
  // than an unstructured, unredacted stderr write.
  log('error', 'fatal startup error', { errorMessage: err && err.message, stack: err && err.stack });
  // exitCode, not exit(1) -- see the ConfigError branch in main() for why.
  process.exitCode = 1;
});
