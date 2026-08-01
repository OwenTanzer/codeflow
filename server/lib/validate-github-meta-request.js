// Validation for the lightweight GitHub-metadata endpoints -- MOO-86.
//
// Backs POST /api/github/blame and POST /api/github/file-content, the
// server-side replacements for the legacy client-side ownership/blame and
// file-preview-fallback features (previously run from the browser using a
// user-supplied GitHub PAT). Reuses validateRepoRequest's/validateFileRequest's
// own owner/repo/ref/path checks rather than duplicating those patterns --
// this is not a repository analysis request, so validateRepoRequest itself
// (which also accepts pr/excludePatterns/sessionId) isn't reused wholesale.
import { validateOwner, validateRepo, validateRef, ValidationError } from './validate-repo-request.js';
import { validatePath } from './validate-file-request.js';

/**
 * @param {object} body
 * @returns {{owner: string, repo: string, ref: string|null, path: string}}
 * @throws {ValidationError}
 */
export function validateGithubMetaRequest(body) {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('request body must be a JSON object');
  }
  const { owner, repo, ref, path } = body;
  validateOwner(owner);
  validateRepo(repo);
  if (ref != null) validateRef(ref);
  const normalizedPath = validatePath(path);

  return { owner, repo, ref: ref ?? null, path: normalizedPath };
}

export { ValidationError };
