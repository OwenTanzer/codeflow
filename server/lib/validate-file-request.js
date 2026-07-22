// File/package request input validation — MOO-70 Commit 7.
//
// Wraps validateRepoRequest (owner/repo/ref/pr, reused verbatim) with the
// two additional fields the file-layer endpoint needs: which path to
// analyze, and an optional explicit depth-mode override
// (src/graph-ir/depthPolicy.js). Runs before the allowlist check and
// before any source retrieval, same as validateRepoRequest itself.
import { validateRepoRequest, ValidationError } from './validate-repo-request.js';

const DEPTH_MODES = new Set(['modules', 'symbols', 'methods', 'full']);

function validatePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new ValidationError('path is required and must be a non-empty string');
  }
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ValidationError('path must not contain empty, "." or ".." segments');
  }
  return normalized;
}

function validateDepth(depth) {
  if (!DEPTH_MODES.has(depth)) {
    throw new ValidationError(`depth must be one of ${[...DEPTH_MODES].join(', ')}, got: ${JSON.stringify(depth)}`);
  }
}

/**
 * @param {object} body
 * @returns {{owner: string, repo: string, ref: string|null, pr: number|null, path: string, depth: string|null}}
 * @throws {ValidationError}
 */
export function validateFileRequest(body) {
  const repoRequest = validateRepoRequest(body);
  const path = validatePath(body && body.path);
  if (body && body.depth != null) validateDepth(body.depth);

  return { ...repoRequest, path, depth: (body && body.depth) || null };
}
