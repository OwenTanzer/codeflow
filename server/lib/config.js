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
  };
}
