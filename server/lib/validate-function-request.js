// Function request input validation — MOO-71 Commit 5.
//
// Wraps validateRepoRequest (owner/repo/ref/pr, reused verbatim) with
// the fields the function-layer endpoint needs: which file to analyze,
// and the exact symbolPath identifying the target function/method
// within it (matches SourceCoordinate.symbolPath — the same field the
// file layer's own drill-down navigation already carries). No `depth`
// field — not applicable at function granularity. Same revision-pinning
// fields as the file request, reused verbatim for the same reason
// (see validate-file-request.js's own comment): "branch, commit, and PR
// function requests preserve revision identity" is this ticket's own
// checklist item for this commit.
import { validateRepoRequest, ValidationError } from './validate-repo-request.js';

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const OWNER_REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

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

function validateSymbolPath(symbolPath) {
  if (!Array.isArray(symbolPath) || symbolPath.length === 0) {
    throw new ValidationError('symbolPath is required and must be a non-empty array of strings');
  }
  if (!symbolPath.every((segment) => typeof segment === 'string' && segment.length > 0)) {
    throw new ValidationError('symbolPath must contain only non-empty strings');
  }
  return symbolPath;
}

// Identical to validate-file-request.js's own validateExpectedRevision —
// same revision-pinning convention, same reasoning (server/routes/
// graph-file.js's assertRevisionStillExpected).
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
 * @returns {{owner: string, repo: string, ref: string|null, pr: number|null, path: string, symbolPath: string[], expectedResolvedSha: string|null, expectedSourceOwner: string|null, expectedSourceRepo: string|null}}
 * @throws {ValidationError}
 */
export function validateFunctionRequest(body) {
  const repoRequest = validateRepoRequest(body);
  const path = validatePath(body && body.path);
  const symbolPath = validateSymbolPath(body && body.symbolPath);
  const expected = validateExpectedRevision(body || {});

  return {
    ...repoRequest,
    path,
    symbolPath,
    expectedResolvedSha: expected.expectedResolvedSha || null,
    expectedSourceOwner: expected.expectedSourceOwner || null,
    expectedSourceRepo: expected.expectedSourceRepo || null,
  };
}
