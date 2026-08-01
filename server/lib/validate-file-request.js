// File/package request input validation — MOO-70 Commit 7.
//
// Wraps validateRepoRequest (owner/repo/ref/pr, reused verbatim) with the
// two additional fields the file-layer endpoint needs: which path to
// analyze, and an optional explicit depth-mode override
// (src/graph-ir/depthPolicy.js). Runs before the allowlist check and
// before any source retrieval, same as validateRepoRequest itself.
import { validateRepoRequest, ValidationError } from './validate-repo-request.js';

const DEPTH_MODES = new Set(['modules', 'symbols', 'methods', 'full']);
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const OWNER_REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

// Exported for server/lib/validate-github-meta-request.js (MOO-86) -- the
// blame/file-content endpoints need the same path normalization/traversal
// checks without duplicating them.
export function validatePath(path) {
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

// PR review finding: a PR-mode drill-down always re-resolves the PR's
// *current* head via GitHub (resolveRef ignores any ref when `pr` is
// set), so a client sending only `pr` (correct for the allowlist-identity
// fix in the prior review round) has no way to detect the PR receiving a
// new commit between the repository graph loading and a file drill-down
// -- silently analyzing a different revision than the one the user is
// looking at, exactly what MOO-70's revision-pinning requirement exists
// to prevent. `expectedResolvedSha`/`expectedSourceOwner`/
// `expectedSourceRepo` let the client declare what it expects (from its
// already-loaded parent graph's own AnalysisContext) so the server can
// reject a stale drill-down instead of silently proceeding
// (server/routes/graph-file.js's `assertRevisionStillExpected`).
function validateExpectedRevision(body) {
  if (body.expectedResolvedSha == null) return {};
  if (typeof body.expectedResolvedSha !== 'string' || !SHA_PATTERN.test(body.expectedResolvedSha)) {
    throw new ValidationError('expectedResolvedSha must be a resolved commit SHA (hex, 7-40 characters) when present');
  }
  const hasSourceOwner = body.expectedSourceOwner != null;
  const hasSourceRepo = body.expectedSourceRepo != null;
  if (hasSourceOwner !== hasSourceRepo) {
    throw new ValidationError('expectedSourceOwner and expectedSourceRepo must be provided together, or neither');
  }
  if (hasSourceOwner && (typeof body.expectedSourceOwner !== 'string' || !OWNER_REPO_PATTERN.test(body.expectedSourceOwner))) {
    throw new ValidationError('expectedSourceOwner must be a valid GitHub owner name when present');
  }
  if (hasSourceRepo && (typeof body.expectedSourceRepo !== 'string' || !OWNER_REPO_PATTERN.test(body.expectedSourceRepo))) {
    throw new ValidationError('expectedSourceRepo must be a valid GitHub repository name when present');
  }
  return {
    expectedResolvedSha: body.expectedResolvedSha.toLowerCase(),
    expectedSourceOwner: body.expectedSourceOwner || null,
    expectedSourceRepo: body.expectedSourceRepo || null,
  };
}

/**
 * @param {object} body
 * @returns {{owner: string, repo: string, ref: string|null, pr: number|null, path: string, depth: string|null, expectedResolvedSha: string|null, expectedSourceOwner: string|null, expectedSourceRepo: string|null}}
 * @throws {ValidationError}
 */
export function validateFileRequest(body) {
  const repoRequest = validateRepoRequest(body);
  const path = validatePath(body && body.path);
  if (body && body.depth != null) validateDepth(body.depth);
  const expected = validateExpectedRevision(body || {});

  return {
    ...repoRequest,
    path,
    depth: (body && body.depth) || null,
    expectedResolvedSha: expected.expectedResolvedSha || null,
    expectedSourceOwner: expected.expectedSourceOwner || null,
    expectedSourceRepo: expected.expectedSourceRepo || null,
  };
}
