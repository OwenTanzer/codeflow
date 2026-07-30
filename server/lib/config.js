// Server configuration — MOO-67 Commits 5-6.
//
// Reads config from environment variables, validating fail-fast at
// startup rather than lazily on first request.
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { venvPythonPath } from '../../scripts/pyan3-venv-path.mjs';

export class ConfigError extends Error {
  constructor(errors) {
    super('Invalid server configuration:\n' + errors.map((e) => ' - ' + e).join('\n'));
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

function parseList(raw) {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// MOO-72 Commit 8: same strict-enum treatment as CACHE_ENABLED/LOG_LEVEL --
// a typo must produce a startup error, not a silently wrong default.
function parseStrictBool(name, raw, defaultValue, errors) {
  if (raw == null || raw === '') return defaultValue;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  errors.push(`${name} must be exactly "true" or "false", got: ${JSON.stringify(raw)}`);
  return defaultValue;
}

/**
 * @param {object} [options]
 * @param {string} options.repoRoot - absolute path to the repo root (dist/, card/, src/ live under this)
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export function loadConfig({ repoRoot, env = process.env }) {
  const errors = [];

  const portRaw = env.PORT;
  const port = portRaw ? Number(portRaw) : 3000;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    errors.push(`PORT must be an integer between 1 and 65535, got: ${JSON.stringify(portRaw)}`);
  }

  const distDir = join(repoRoot, 'dist');
  if (!existsSync(join(distDir, 'index.html'))) {
    errors.push(`Build output not found at ${join(distDir, 'index.html')} — run \`npm run build\` first.`);
  }

  const workspaceRoot = env.WORKSPACE_ROOT
    ? join(env.WORKSPACE_ROOT)
    : join(tmpdir(), 'codeflow-workspaces');

  const nodeEnv = env.NODE_ENV || 'development';

  // MOO-67 Commit 6: private-use auth gate + server-held GitHub credential
  // + repository allowlist. All required, always -- no environment-based
  // bypass, so a missing NODE_ENV=production can't silently ship an
  // unprotected instance. Set these explicitly for local development too.
  const authToken = env.AUTH_TOKEN || '';
  if (!authToken) {
    errors.push('AUTH_TOKEN is required — this is the shared secret private clients must send as `Authorization: Bearer <token>`.');
  }

  const githubToken = env.GITHUB_TOKEN || '';
  if (!githubToken) {
    errors.push('GITHUB_TOKEN is required — a GitHub personal access token the server uses to fetch repository content.');
  }

  const allowedRepos = parseList(env.ALLOWED_REPOS).map((s) => s.toLowerCase());
  const allowedOwners = parseList(env.ALLOWED_OWNERS).map((s) => s.toLowerCase());
  if (allowedRepos.length === 0 && allowedOwners.length === 0) {
    errors.push(
      'At least one of ALLOWED_REPOS (comma-separated owner/repo) or ALLOWED_OWNERS (comma-separated owner/org names) is required.'
    );
  }

  const rateLimitPerMinute = env.RATE_LIMIT_PER_MINUTE ? Number(env.RATE_LIMIT_PER_MINUTE) : 30;
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute <= 0) {
    errors.push(`RATE_LIMIT_PER_MINUTE must be a positive integer, got: ${JSON.stringify(env.RATE_LIMIT_PER_MINUTE)}`);
  }

  const maxRequestBodyBytes = env.MAX_REQUEST_BODY_BYTES ? Number(env.MAX_REQUEST_BODY_BYTES) : 16 * 1024;
  if (!Number.isInteger(maxRequestBodyBytes) || maxRequestBodyBytes <= 0) {
    errors.push(`MAX_REQUEST_BODY_BYTES must be a positive integer, got: ${JSON.stringify(env.MAX_REQUEST_BODY_BYTES)}`);
  }

  // MOO-72 Commit 1A review: 750, not 500 -- matches the ceiling the
  // now-replaced client-side browser path used (index.html's
  // ANALYSIS_LIMITS.repoMax). That path sampled down to 750 files with a
  // warning rather than rejecting; this route rejects outright past the
  // limit instead (see selectAnalyzableFiles) -- a deliberate, documented
  // behavior change (explicit rejection over silent truncation), not a
  // silently smaller supported repository size.
  const maxRepoFiles = env.MAX_REPO_FILES ? Number(env.MAX_REPO_FILES) : 750;
  if (!Number.isInteger(maxRepoFiles) || maxRepoFiles <= 0) {
    errors.push(`MAX_REPO_FILES must be a positive integer, got: ${JSON.stringify(env.MAX_REPO_FILES)}`);
  }

  // PR review finding: MAX_REPO_FILES caps file *count* but not byte size —
  // the GitHub-backed path fetches every accepted blob into memory and
  // holds it resident before analysis. That mattered less while
  // repositories were tightly allowlisted; the wildcard follow-up means
  // any authenticated caller can point the server at any public repo, and
  // a repo with a few hundred enormous blobs could exhaust memory despite
  // staying under MAX_REPO_FILES. GitHub's tree API already reports each
  // blob's size, so oversized files are rejected before content is ever
  // fetched/decoded (see server/lib/github-analyzer-bridge.js).
  const maxFileBytes = env.MAX_FILE_BYTES ? Number(env.MAX_FILE_BYTES) : 1 * 1024 * 1024;
  if (!Number.isInteger(maxFileBytes) || maxFileBytes <= 0) {
    errors.push(`MAX_FILE_BYTES must be a positive integer, got: ${JSON.stringify(env.MAX_FILE_BYTES)}`);
  }

  const maxRepoBytes = env.MAX_REPO_BYTES ? Number(env.MAX_REPO_BYTES) : 25 * 1024 * 1024;
  if (!Number.isInteger(maxRepoBytes) || maxRepoBytes <= 0) {
    errors.push(`MAX_REPO_BYTES must be a positive integer, got: ${JSON.stringify(env.MAX_REPO_BYTES)}`);
  }

  // MOO-69 Commit 6 (closing a gap left by Commit 2, which added the
  // /api/graph/repository endpoint but never actually wired a timeout):
  // bounds analyzeGithubRepo()'s fetch+parse phase so a very large or
  // slow-to-respond repository fails clearly (ErrorCategory 'timeout')
  // instead of hanging the request indefinitely.
  const graphAnalysisTimeoutMs = env.GRAPH_ANALYSIS_TIMEOUT_MS ? Number(env.GRAPH_ANALYSIS_TIMEOUT_MS) : 60 * 1000;
  if (!Number.isInteger(graphAnalysisTimeoutMs) || graphAnalysisTimeoutMs <= 0) {
    errors.push(`GRAPH_ANALYSIS_TIMEOUT_MS must be a positive integer, got: ${JSON.stringify(env.GRAPH_ANALYSIS_TIMEOUT_MS)}`);
  }

  // MOO-70 Commit 2: the pyan3 subprocess is invoked as `${pythonBin} -m
  // pyan ...`. Railway/CI (Linux) ship `python3`; some local dev machines
  // only have `python` on PATH — hence an env override rather than a
  // hardcoded platform check.
  //
  // Live-verified finding (2026-07-22): a global pip install of pyan3
  // does not survive Railway's build → runtime image split (see
  // scripts/install-pyan3.mjs), so that script now installs into a venv
  // rooted inside the repo directory instead. Default to that venv's
  // python when it's present, since a bare `python3` on the runtime image
  // has no pyan3 installed at all in that case.
  const venvPython = venvPythonPath(repoRoot);
  const pythonBin = env.PYTHON_BIN || (existsSync(venvPython) ? venvPython : 'python3');
  if (!pythonBin) {
    errors.push('PYTHON_BIN must not be empty when set.');
  }

  const pyan3TimeoutMs = env.PYAN3_TIMEOUT_MS ? Number(env.PYAN3_TIMEOUT_MS) : 30 * 1000;
  if (!Number.isInteger(pyan3TimeoutMs) || pyan3TimeoutMs <= 0) {
    errors.push(`PYAN3_TIMEOUT_MS must be a positive integer, got: ${JSON.stringify(env.PYAN3_TIMEOUT_MS)}`);
  }

  // MOO-72 Commit 2: the centralized cross-layer graph cache. This store is
  // process-local -- cleared on every restart/deploy and never shared across
  // replicas -- so these bounds are per-instance, and the whole design
  // assumes a single running Railway instance.
  const cacheMaxItems = env.CACHE_MAX_ITEMS ? Number(env.CACHE_MAX_ITEMS) : 200;
  if (!Number.isInteger(cacheMaxItems) || cacheMaxItems <= 0) {
    errors.push(`CACHE_MAX_ITEMS must be a positive integer, got: ${JSON.stringify(env.CACHE_MAX_ITEMS)}`);
  }

  // Bounded by bytes as well as item count: a handful of large repository
  // graphs can exhaust a Railway container's memory well before 200 entries.
  const cacheMaxBytes = env.CACHE_MAX_BYTES ? Number(env.CACHE_MAX_BYTES) : 256 * 1024 * 1024;
  if (!Number.isInteger(cacheMaxBytes) || cacheMaxBytes <= 0) {
    errors.push(`CACHE_MAX_BYTES must be a positive integer, got: ${JSON.stringify(env.CACHE_MAX_BYTES)}`);
  }

  const cacheTtlMs = env.CACHE_TTL_MS ? Number(env.CACHE_TTL_MS) : 60 * 60 * 1000;
  if (!Number.isInteger(cacheTtlMs) || cacheTtlMs <= 0) {
    errors.push(`CACHE_TTL_MS must be a positive integer, got: ${JSON.stringify(env.CACHE_TTL_MS)}`);
  }

  // Strictly 'true'/'false': a typo like CACHE_ENABLED=fasle must not
  // silently leave caching on when the operator's intent was to turn it off
  // (e.g. to reproduce a stale-result bug).
  let cacheEnabled = true;
  if (env.CACHE_ENABLED != null && env.CACHE_ENABLED !== '') {
    if (env.CACHE_ENABLED === 'true') cacheEnabled = true;
    else if (env.CACHE_ENABLED === 'false') cacheEnabled = false;
    else errors.push(`CACHE_ENABLED must be exactly "true" or "false", got: ${JSON.stringify(env.CACHE_ENABLED)}`);
  }

  // MOO-72 Commit 3: same strict-enum treatment as CACHE_ENABLED above --
  // a typo must produce a startup error, not a silently wrong log volume.
  const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
  let logLevel = 'info';
  if (env.LOG_LEVEL != null && env.LOG_LEVEL !== '') {
    if (LOG_LEVELS.includes(env.LOG_LEVEL)) logLevel = env.LOG_LEVEL;
    else errors.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got: ${JSON.stringify(env.LOG_LEVEL)}`);
  }

  // MOO-72 Commit 8: feature flags. Each defaults to today's always-on
  // behavior so an existing deployment's behavior doesn't change unless an
  // operator explicitly opts in to disabling something.
  const fileLayerEnabled = parseStrictBool('FILE_LAYER_ENABLED', env.FILE_LAYER_ENABLED, true, errors);
  const functionLayerEnabled = parseStrictBool('FUNCTION_LAYER_ENABLED', env.FUNCTION_LAYER_ENABLED, true, errors);
  // Gates server/routes/graph-file.js's pyan3-fails -> tree-sitter-only
  // degrade path specifically. The function layer has no analogous fallback
  // to gate (see graph-function.js's own header comment) -- there is no
  // separate "renderer fallback" flag because no separate renderer-fallback
  // subsystem exists.
  const degradedAnalysisEnabled = parseStrictBool('DEGRADED_ANALYSIS_ENABLED', env.DEGRADED_ANALYSIS_ENABLED, true, errors);
  // Defaults false, unlike the flags above: no experimental interaction
  // exists yet, so there is nothing to safely default "on". Checked
  // directly (grep for 'depth' in src/graph-ir/depthPolicy.js and
  // server/lib/validate-file-request.js) whether a depth-beyond-'full' or
  // similar opt-in surface already existed to gate -- it doesn't; depth is
  // a fixed enum (modules/symbols/methods/full) with nothing past 'full'.
  // This flag currently gates no behavior at all -- it exists so a future
  // experimental interaction has a config knob to attach to from day one,
  // called out explicitly here (and in this commit's PR description)
  // rather than silently presented as complete. The next piece of code
  // that wants an experimental/opt-in gate should read
  // `config.experimentalInteractionsEnabled` rather than inventing a
  // second flag.
  const experimentalInteractionsEnabled = parseStrictBool(
    'EXPERIMENTAL_INTERACTIONS_ENABLED',
    env.EXPERIMENTAL_INTERACTIONS_ENABLED,
    false,
    errors
  );

  // MOO-72 Commit 8: no server-wide concurrency cap existed before this --
  // only per-minute rate limiting and per-key request de-duplication, either
  // of which coexists with an unbounded number of *distinct* concurrent
  // analyses. Default of 4 is a conservative starting point, not a
  // load-tested number: tree-sitter parsing runs synchronously in-process
  // (blocks the single event loop thread while running) and Railway's
  // default/hobby-tier containers commonly have 1-2 vCPUs. Meant to be
  // tuned from real Railway metrics after deployment -- see docs/deployment.md.
  const maxConcurrentAnalyses = env.MAX_CONCURRENT_ANALYSES ? Number(env.MAX_CONCURRENT_ANALYSES) : 4;
  if (!Number.isInteger(maxConcurrentAnalyses) || maxConcurrentAnalyses <= 0) {
    errors.push(`MAX_CONCURRENT_ANALYSES must be a positive integer, got: ${JSON.stringify(env.MAX_CONCURRENT_ANALYSES)}`);
  }

  // Previously a hardcoded default parameter in fetchAllContents
  // (server/lib/github-analyzer-bridge.js) -- now operator-configurable.
  const githubFetchConcurrency = env.GITHUB_FETCH_CONCURRENCY ? Number(env.GITHUB_FETCH_CONCURRENCY) : 8;
  if (!Number.isInteger(githubFetchConcurrency) || githubFetchConcurrency <= 0) {
    errors.push(`GITHUB_FETCH_CONCURRENCY must be a positive integer, got: ${JSON.stringify(env.GITHUB_FETCH_CONCURRENCY)}`);
  }

  // Previously a hardcoded default parameter in runPyan3
  // (server/lib/pyan3Adapter.js) -- now operator-configurable.
  const pyan3MaxBufferBytes = env.PYAN3_MAX_BUFFER_BYTES ? Number(env.PYAN3_MAX_BUFFER_BYTES) : 20 * 1024 * 1024;
  if (!Number.isInteger(pyan3MaxBufferBytes) || pyan3MaxBufferBytes <= 0) {
    errors.push(`PYAN3_MAX_BUFFER_BYTES must be a positive integer, got: ${JSON.stringify(env.PYAN3_MAX_BUFFER_BYTES)}`);
  }

  if (errors.length > 0) {
    throw new ConfigError(errors);
  }

  return {
    port,
    repoRoot,
    distDir,
    workspaceRoot,
    nodeEnv,
    authToken,
    githubToken,
    allowedRepos,
    allowedOwners,
    rateLimitPerMinute,
    maxRequestBodyBytes,
    maxRepoFiles,
    maxFileBytes,
    maxRepoBytes,
    graphAnalysisTimeoutMs,
    pythonBin,
    pyan3TimeoutMs,
    cacheMaxItems,
    cacheMaxBytes,
    cacheTtlMs,
    cacheEnabled,
    logLevel,
    fileLayerEnabled,
    functionLayerEnabled,
    degradedAnalysisEnabled,
    experimentalInteractionsEnabled,
    maxConcurrentAnalyses,
    githubFetchConcurrency,
    pyan3MaxBufferBytes,
  };
}
