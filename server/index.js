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
import { log, generateRequestId } from './lib/logger.js';
import { WorkspaceManager } from './lib/workspace.js';
import { createStaticHandler } from './lib/static.js';
import { createHealthHandler, createReadinessHandler } from './lib/health.js';
import { isAuthorized } from './lib/auth.js';
import { RateLimiter } from './lib/rate-limit.js';
import { createAnalyzeHandler } from './routes/analyze.js';
import { createAnalyzeRepoHandler } from './routes/analyze-repo.js';
import { createGraphRepositoryHandler } from './routes/graph-repository.js';
import { createGraphFileHandler } from './routes/graph-file.js';
import { verifyPyan3Available } from './lib/pyan3Adapter.js';

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

  const workspaceManager = new WorkspaceManager(config.workspaceRoot);
  try {
    await workspaceManager.ensureRoot();
  } catch (err) {
    process.stderr.write(
      `[codeflow-server] Workspace root ${config.workspaceRoot} is not writable: ${err.message}\n`
    );
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
      message: err.message,
    });
  }

  const rateLimiter = new RateLimiter(config.rateLimitPerMinute);
  const rateLimitSweep = setInterval(() => rateLimiter.sweep(), 60_000);
  rateLimitSweep.unref();

  const handleStatic = createStaticHandler(config.distDir);
  const handleHealth = createHealthHandler({ config });
  const handleReadiness = createReadinessHandler({ config, getPyan3Available: () => pyan3Available });
  const handleAnalyze = createAnalyzeHandler({ config, workspaceManager });
  const handleAnalyzeRepo = createAnalyzeRepoHandler({ config });
  const handleGraphRepository = createGraphRepositoryHandler({ config });
  const handleGraphFile = createGraphFileHandler({ config, workspaceManager });

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
      } else if (isApiRoute) {
        sendJson(res, 404, { error: 'Not found' });
      } else {
        await handleStatic(req, res);
      }
    } catch (err) {
      log('error', 'unhandled request error', { requestId, message: err && err.message });
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
    });
  });
}

main().catch((err) => {
  process.stderr.write('[codeflow-server] fatal startup error: ' + (err.stack || err.message) + '\n');
  process.exit(1);
});
