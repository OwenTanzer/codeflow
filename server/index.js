// Server entry point — MOO-67 Commits 5-6.
//
// Establishes the durable application shell: config validated at startup
// (fail fast, not on first request), health/readiness endpoints (public —
// Railway's own monitoring needs to reach these without a token),
// namespaced /api/* analysis endpoints gated behind a private-use auth
// token + per-IP rate limiting, structured per-request logging, and the
// request-scoped workspace abstraction later analyzers (MOO-70/71) will
// build on.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { loadConfig, ConfigError } from './lib/config.js';
import { log, configureLogger, generateRequestId } from './lib/logger.js';
import { WorkspaceManager } from './lib/workspace.js';
import { createStaticHandler } from './lib/static.js';
import { createHealthHandler, createReadinessHandler } from './lib/health.js';
import { isAuthorized } from './lib/auth.js';
import { RateLimiter } from './lib/rate-limit.js';
import { GraphCache } from './lib/graph-cache.js';
import { Metrics } from './lib/metrics.js';
import { createAnalyzeHandler } from './routes/analyze.js';
import { createAnalyzeRepoHandler } from './routes/analyze-repo.js';
import { createGraphRepositoryHandler } from './routes/graph-repository.js';
import { createGraphFileHandler } from './routes/graph-file.js';
import { createGraphFunctionHandler } from './routes/graph-function.js';
import { verifyPyan3Available } from './lib/pyan3Adapter.js';
import { initPythonLanguageService } from '@codevisualizer/core';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..');

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function clientKey(req) {
  // Railway (and most PaaS) sit behind a proxy — X-Forwarded-For's first
  // entry is the original client. Falls back to the raw socket address
  // for local/direct connections.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

async function main() {
  let config;
  try {
    config = loadConfig({ repoRoot });
  } catch (err) {
    if (err instanceof ConfigError) {
      // Actionable, not a stack trace: this is meant to be read by whoever
      // just ran `npm start`/deployed to Railway.
      process.stderr.write('[codeflow-server] ' + err.message + '\n');
      process.exit(1);
    }
    throw err;
  }

  // Configured immediately once config exists -- everything logged from
  // this point on is level-gated and redacted (AUTH_TOKEN/GITHUB_TOKEN
  // scrubbed verbatim wherever they'd appear in a logged string, plus the
  // generic token-shape patterns in logger.js). The one thing that can
  // never go through this path is the loadConfig failure above: there is
  // no config yet at that point to redact with, so it stays a plain
  // stderr write.
  configureLogger({ level: config.logLevel, secrets: [config.authToken, config.githubToken] });

  const workspaceManager = new WorkspaceManager(config.workspaceRoot);
  try {
    await workspaceManager.ensureRoot();
  } catch (err) {
    log('error', 'workspace root is not writable', { workspaceRoot: config.workspaceRoot, errorMessage: err.message });
    process.exit(1);
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
  let pyan3Available = true;
  try {
    await verifyPyan3Available({ pythonBin: config.pythonBin });
  } catch (err) {
    pyan3Available = false;
    log('warn', 'pyan3 unavailable at startup -- /api/graph/file will run in tree-sitter-only (degraded) mode until this is fixed', {
      errorMessage: err.message,
    });
  }

  // MOO-71 Commit 5: mirrors the pyan3 startup-check pattern above
  // exactly. Unlike pyan3, there's no per-request degraded fallback for
  // the function layer (no fallback analyzer exists) -- graph-function.js
  // uses this flag to fail clearly before even attempting a GitHub
  // fetch, rather than pretending to proceed.
  let codeVisualizerAvailable = true;
  try {
    await initPythonLanguageService();
  } catch (err) {
    codeVisualizerAvailable = false;
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

  // MOO-72 Commit 3: one shared counter store across all three graph
  // layers, same process-local/cumulative-since-start lifetime as
  // graphCache above. A required constructor dependency for every route
  // handler below (not an optional no-op default) -- a silent default
  // would hide exactly the kind of production wiring mistake this is
  // meant to prevent.
  const metrics = new Metrics();
  const metricsSummaryInterval = setInterval(() => {
    // Logged at 'info' -- LOG_LEVEL=warn or error suppresses this line,
    // same as any other info log. That's expected, not a sign metrics
    // collection itself is broken.
    log('info', 'metrics summary', metrics.snapshot());
  }, 5 * 60 * 1000);
  metricsSummaryInterval.unref();

  const handleStatic = createStaticHandler(config.distDir);
  const handleHealth = createHealthHandler({ config });
  const handleReadiness = createReadinessHandler({
    config,
    getPyan3Available: () => pyan3Available,
    getCodeVisualizerAvailable: () => codeVisualizerAvailable,
  });
  const handleAnalyze = createAnalyzeHandler({ config, workspaceManager });
  const handleAnalyzeRepo = createAnalyzeRepoHandler({ config });
  const handleGraphRepository = createGraphRepositoryHandler({ config, cache: graphCache, metrics });
  const handleGraphFile = createGraphFileHandler({ config, workspaceManager, cache: graphCache, metrics });
  const handleGraphFunction = createGraphFunctionHandler({
    config,
    getCodeVisualizerAvailable: () => codeVisualizerAvailable,
    cache: graphCache,
    metrics,
  });

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
      } else if (isApiRoute && !isAuthorized(req, config)) {
        log('warn', 'rejected unauthenticated request', { requestId, path: url.pathname });
        sendJson(res, 401, { error: 'Missing or invalid Authorization header' });
      } else if (isApiRoute && !rateLimiter.check(clientKey(req)).allowed) {
        log('warn', 'rejected rate-limited request', { requestId, path: url.pathname });
        sendJson(res, 429, { error: 'Rate limit exceeded, try again shortly' });
      } else if (url.pathname === '/api/analyze' && req.method === 'POST') {
        await handleAnalyze(req, res, requestId);
      } else if (url.pathname === '/api/analyze-repo' && req.method === 'POST') {
        await handleAnalyzeRepo(req, res, requestId);
      } else if (url.pathname === '/api/graph/repository' && req.method === 'POST') {
        await handleGraphRepository(req, res, requestId);
      } else if (url.pathname === '/api/graph/file' && req.method === 'POST') {
        await handleGraphFile(req, res, requestId);
      } else if (url.pathname === '/api/graph/function' && req.method === 'POST') {
        await handleGraphFunction(req, res, requestId);
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
      pyan3Available,
      codeVisualizerAvailable,
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
  process.exit(1);
});
