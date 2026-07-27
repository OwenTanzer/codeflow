// Repository/branch/commit/PR input validation — MOO-67 Commit 6.
//
// Runs before the allowlist check and before any source retrieval — a
// malformed request should never reach GitHub or the analyzer. Patterns
// are deliberately conservative (narrower than GitHub actually allows in
// some cases) since the cost of rejecting a rare valid name is low and the
// cost of building a URL from an unvalidated string is not.
const OWNER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const REPO_PATTERN = /^[a-zA-Z0-9._-]{1,100}$/;
const REF_PATTERN = /^[a-zA-Z0-9._\/-]{1,200}$/;

// MOO-72 Commit 1A: exclude patterns are user-supplied, untrusted text that
// gets compiled into regexes (see src/analyzer.js's compileExcludePatterns)
// and joined into the cache key -- capped on count and length before any
// of that happens, same conservative posture as the patterns above.
const MAX_EXCLUDE_PATTERNS = 50;
const MAX_EXCLUDE_PATTERN_LENGTH = 200;
const MAX_EXCLUDE_PATTERNS_AGGREGATE_LENGTH = 4000;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function validateOwner(owner) {
  if (typeof owner !== 'string' || !OWNER_PATTERN.test(owner)) {
    throw new ValidationError('owner must be a valid GitHub username/org (alphanumeric and hyphens, max 39 chars)');
  }
}

function validateRepo(repo) {
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo) || repo === '.' || repo === '..') {
    throw new ValidationError('repo must be a valid GitHub repository name (alphanumeric, dots, hyphens, underscores, max 100 chars)');
  }
}

function validateRef(ref) {
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref) || ref.includes('..') || ref.startsWith('/') || ref.startsWith('-')) {
    throw new ValidationError('ref must be a valid branch name or commit SHA');
  }
}

function validatePr(pr) {
  if (!Number.isInteger(pr) || pr <= 0 || pr > 1_000_000) {
    throw new ValidationError('pr must be a positive integer');
  }
}

function validateExcludePatterns(excludePatterns) {
  if (!Array.isArray(excludePatterns)) {
    throw new ValidationError('excludePatterns must be an array of strings');
  }
  if (excludePatterns.length > MAX_EXCLUDE_PATTERNS) {
    throw new ValidationError(`excludePatterns must contain at most ${MAX_EXCLUDE_PATTERNS} entries`);
  }
  let aggregateLength = 0;
  for (const pattern of excludePatterns) {
    if (typeof pattern !== 'string') {
      throw new ValidationError('excludePatterns must contain only strings');
    }
    if (pattern.length > MAX_EXCLUDE_PATTERN_LENGTH) {
      throw new ValidationError(`each excludePatterns entry must be at most ${MAX_EXCLUDE_PATTERN_LENGTH} characters`);
    }
    aggregateLength += pattern.length;
  }
  if (aggregateLength > MAX_EXCLUDE_PATTERNS_AGGREGATE_LENGTH) {
    throw new ValidationError(`excludePatterns' combined length must be at most ${MAX_EXCLUDE_PATTERNS_AGGREGATE_LENGTH} characters`);
  }
  return excludePatterns;
}

/**
 * @param {object} body
 * @returns {{owner: string, repo: string, ref: string|null, pr: number|null, excludePatterns: string[]}}
 * @throws {ValidationError}
 */
export function validateRepoRequest(body) {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('request body must be a JSON object');
  }
  const { owner, repo, ref, pr, excludePatterns } = body;
  validateOwner(owner);
  validateRepo(repo);

  if (ref != null && pr != null) {
    throw new ValidationError('specify at most one of "ref" or "pr", not both');
  }
  if (ref != null) validateRef(ref);
  if (pr != null) validatePr(pr);
  if (excludePatterns != null) validateExcludePatterns(excludePatterns);

  return { owner, repo, ref: ref ?? null, pr: pr ?? null, excludePatterns: excludePatterns ?? [] };
}
