// Client-side fetch wrappers for POST /api/github/blame and
// POST /api/github/file-content -- MOO-86.
//
// Replaces the legacy client-side GitHub.getBlame/GitHub.getFile calls
// (src/analyzer.js), which ran directly against api.github.com using a
// user-supplied PAT typed into the toolbar. Mirrors
// src/state/graphRepositoryClient.js: same shared authenticated request
// helper (src/state/serverRequest.js), same error shape.
import { ServerRequestError, buildServerJsonRequest, sendServerJsonRequest } from './serverRequest.js';

export class GithubMetaClientError extends ServerRequestError {
  constructor(message, options) {
    super(message, options);
    this.name = 'GithubMetaClientError';
  }
}

/**
 * @param {object} input
 * @param {string} input.owner
 * @param {string} input.repo
 * @param {string} input.path
 * @param {string} [input.ref] - a resolved commit SHA; omit for the default branch
 * @param {string} input.appPassword
 * @param {AbortSignal} [input.signal]
 * @returns {{url: string, init: RequestInit}}
 */
export function buildBlameRequest({ owner, repo, path, ref, appPassword, signal }) {
  const body = { owner, repo, path, ref: ref || undefined };
  return buildServerJsonRequest({ path: '/api/github/blame', body, appPassword, signal });
}

/**
 * @param {object} input - see buildBlameRequest
 * @returns {Promise<Array<{name: string, commits: number, percent: number}>>}
 */
export async function fetchBlame(input) {
  const { url, init } = buildBlameRequest(input);
  const body = await sendServerJsonRequest({ url, init, ErrorClass: GithubMetaClientError });
  return body.authors;
}

/**
 * @param {object} input - see buildBlameRequest
 * @returns {{url: string, init: RequestInit}}
 */
export function buildFileContentRequest({ owner, repo, path, ref, appPassword, signal }) {
  const body = { owner, repo, path, ref: ref || undefined };
  return buildServerJsonRequest({ path: '/api/github/file-content', body, appPassword, signal });
}

/**
 * @param {object} input - see buildBlameRequest
 * @returns {Promise<string|null>}
 */
export async function fetchFileContentFromServer(input) {
  const { url, init } = buildFileContentRequest(input);
  const body = await sendServerJsonRequest({ url, init, ErrorClass: GithubMetaClientError });
  return body.content;
}
