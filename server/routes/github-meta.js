// POST /api/github/blame and POST /api/github/file-content -- MOO-86.
//
// Server-side replacements for two legacy client-side features that
// previously called api.github.com directly from the browser using a
// user-supplied PAT typed into the toolbar: per-file commit-author tally
// (the ownership/blame panel) and single-file content fetch (the
// file-preview fallback for a GitHub-sourced repository, whose server graph
// never carries file content). Moving both here lets the client-side PAT
// field be removed entirely -- these now run with the server's own
// GITHUB_TOKEN, same as every other GitHub-backed route.
//
// Deliberately much lighter-weight than the three graph routes
// (graph-repository.js/graph-file.js/graph-function.js): each is a single
// GitHub API round trip with no analysis, so there's no GraphIR/
// AdapterResult, cache, concurrency limiter, or per-request metrics here --
// that machinery exists to bound and observe expensive analyses, and would
// be pure overhead for a cheap read a client already retries on its own.
import { readJsonBody, BodyTooLargeError } from '../lib/http-body.js';
import { isRepoAllowed } from '../lib/allowlist.js';
import { createRequestLogger } from '../lib/logger.js';
import { validateGithubMetaRequest, ValidationError } from '../lib/validate-github-meta-request.js';
import { fetchCommitAuthorTally, fetchSingleFileContent, GithubFetchError } from '../lib/github-analyzer-bridge.js';

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Shared body-parse / validate / allowlist-check prologue for both routes
 * below. Returns null (having already sent a response) on any rejection, so
 * each handler can just check for that and return.
 * @returns {Promise<{owner: string, repo: string, ref: string|null, path: string}|null>}
 */
async function parseAndAuthorize(req, res, config, requestId, log) {
  let body;
  try {
    body = await readJsonBody(req, config.maxRequestBodyBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: 'Request body too large', requestId });
    } else {
      sendJson(res, 400, { error: 'Request body must be valid JSON', requestId });
    }
    return null;
  }

  let request;
  try {
    request = validateGithubMetaRequest(body);
  } catch (err) {
    if (err instanceof ValidationError) {
      log.warn('rejected request: invalid input', { errorMessage: err.message });
      sendJson(res, 400, { error: err.message, requestId });
      return null;
    }
    throw err;
  }

  if (!isRepoAllowed(request.owner, request.repo, config)) {
    log.warn('rejected request: repository not allowlisted', { owner: request.owner, repo: request.repo });
    sendJson(res, 403, { error: 'This repository is not on the allowlist', requestId });
    return null;
  }

  return request;
}

/** @param {{config: object}} deps */
export function createGithubBlameHandler({ config }) {
  return async function handleGithubBlame(req, res, requestId) {
    const log = createRequestLogger(requestId, { layer: 'github-blame' });
    const request = await parseAndAuthorize(req, res, config, requestId, log);
    if (!request) return;
    try {
      const authors = await fetchCommitAuthorTally(request, config);
      sendJson(res, 200, { authors, requestId });
    } catch (err) {
      if (err instanceof GithubFetchError) {
        log.warn('github blame fetch failed', { errorMessage: err.message });
        sendJson(res, 502, { error: err.message, requestId });
        return;
      }
      log.error('github blame internal error', { errorMessage: err && err.message });
      sendJson(res, 500, { error: 'Failed to fetch commit history', requestId });
    }
  };
}

/** @param {{config: object}} deps */
export function createGithubFileContentHandler({ config }) {
  return async function handleGithubFileContent(req, res, requestId) {
    const log = createRequestLogger(requestId, { layer: 'github-file-content' });
    const request = await parseAndAuthorize(req, res, config, requestId, log);
    if (!request) return;
    try {
      const content = await fetchSingleFileContent(request, config);
      if (content == null) {
        sendJson(res, 404, { error: 'File not found at the requested revision', requestId });
        return;
      }
      sendJson(res, 200, { content, requestId });
    } catch (err) {
      if (err instanceof GithubFetchError) {
        log.warn('github file-content fetch failed', { errorMessage: err.message });
        sendJson(res, 502, { error: err.message, requestId });
        return;
      }
      log.error('github file-content internal error', { errorMessage: err && err.message });
      sendJson(res, 500, { error: 'Failed to fetch file content', requestId });
    }
  };
}
