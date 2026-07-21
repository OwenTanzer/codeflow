// Canonical GitHub analysis context — MOO-68 Commit 2.
//
// Repository, branch, commit, and PR requests are four different shapes a
// caller might send; every layer downstream (repository/file/function
// adapters) needs to reason about exactly one normalized shape instead of
// re-deriving "which SHA does this actually mean" independently in each
// place. This module is that single normalization point, plus the rule
// that a drill-down request's context must match its parent graph's
// context exactly — no silent revision drift between a repository graph
// and the file/function graphs opened from it.
//
// Deliberately does not perform the actual GitHub API resolution (turning a
// branch name into a commit SHA) — that's server/lib/github-analyzer-bridge.js's
// job, reused here as an already-solved problem. This module only defines
// the *shape* callers normalize into and the *rules* for validating it, so
// it has no network dependency and no server/browser split.

/** @typedef {'repository'|'branch'|'commit'|'pr'} AnalysisMode */

/**
 * @typedef {Object} AnalysisContext
 * @property {string} owner - the requested/base repository owner (PR provenance and allowlist checks key off this)
 * @property {string} repo - the requested/base repository name
 * @property {AnalysisMode} mode
 * @property {string|null} ref - the raw ref the caller named (branch name, tag, or null for repository/commit/pr modes where no branch name applies)
 * @property {string} resolvedSha - the concrete commit SHA this context is pinned to; always present, never a branch name
 * @property {string} sourceOwner - the repository owner content must actually be fetched from at resolvedSha. Equal to `owner` for every mode except a forked PR, where a PR's head commit typically lives only in the contributor's fork (see server/lib/github-analyzer-bridge.js's resolveRef(), which discovered this the hard way for MOO-67) — coordinates and cache identity must key off this, not `owner`, or a later fetch for that coordinate 404s against the wrong repository.
 * @property {string} sourceRepo - the repository name paired with sourceOwner
 * @property {string|null} baseSha - present for diff-style requests (pr mode); null otherwise
 * @property {string|null} headSha - present for diff-style requests (pr mode); null otherwise
 * @property {number|null} prNumber - present only in pr mode
 */

export class AnalysisContextError extends Error {
  constructor(errors) {
    super('Invalid analysis context:\n' + errors.map((e) => ' - ' + e).join('\n'));
    this.name = 'AnalysisContextError';
    this.errors = errors;
  }
}

const MODES = new Set(['repository', 'branch', 'commit', 'pr']);
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const OWNER_REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

function isSha(value) {
  return typeof value === 'string' && SHA_PATTERN.test(value);
}

/**
 * Normalize one of the four request shapes into a single canonical
 * AnalysisContext. Every field the caller doesn't supply for a given mode
 * is explicitly null (not merely absent), so downstream code can pattern-
 * match on presence without an `in` check.
 *
 * Accepted input shapes:
 *  - repository: { owner, repo, resolvedSha }                     (mode: 'repository', analyzing the default branch's tip — resolvedSha is still required: this module never resolves refs itself)
 *  - branch:     { owner, repo, ref, resolvedSha }                 (mode: 'branch')
 *  - commit:     { owner, repo, resolvedSha }                      (mode: 'commit')
 *  - pr:         { owner, repo, prNumber, resolvedSha, baseSha?, headSha?, sourceOwner?, sourceRepo? } (mode: 'pr' — resolvedSha is the PR head SHA, matching resolveRef()'s existing convention in server/lib/github-analyzer-bridge.js; sourceOwner/sourceRepo name the repository resolveRef() actually found that SHA in — GitHub's `head.repo`, which is the *contributor's fork* for a cross-repository PR — and default to the base owner/repo when omitted, i.e. a same-repository PR)
 *
 * Only pr mode may set sourceOwner/sourceRepo: repository/branch/commit
 * requests have no fork concept — the resolved SHA is by definition already
 * in the named repository.
 *
 * @param {object} input
 * @returns {AnalysisContext}
 */
export function normalizeContext(input) {
  const errors = [];
  const raw = input || {};

  if (!raw.owner || !OWNER_REPO_PATTERN.test(raw.owner)) errors.push('owner is required and must be a valid GitHub owner name');
  if (!raw.repo || !OWNER_REPO_PATTERN.test(raw.repo)) errors.push('repo is required and must be a valid GitHub repository name');
  if (!isSha(raw.resolvedSha)) errors.push('resolvedSha is required and must already be a resolved commit SHA (this module does not resolve refs)');

  let mode = raw.mode;
  if (!mode) {
    if (raw.prNumber != null) mode = 'pr';
    else if (raw.ref) mode = 'branch';
    else mode = 'commit';
  }
  if (!MODES.has(mode)) errors.push(`mode must be one of ${[...MODES].join(', ')}, got: ${JSON.stringify(mode)}`);

  if (mode === 'pr') {
    if (!Number.isInteger(raw.prNumber) || raw.prNumber <= 0) errors.push('prNumber is required and must be a positive integer in pr mode');
    if (raw.baseSha != null && !isSha(raw.baseSha)) errors.push('baseSha must be a resolved commit SHA when present');
    if (raw.headSha != null && !isSha(raw.headSha)) errors.push('headSha must be a resolved commit SHA when present');
    if (raw.sourceOwner != null && !OWNER_REPO_PATTERN.test(raw.sourceOwner)) errors.push('sourceOwner must be a valid GitHub owner name when present');
    if (raw.sourceRepo != null && !OWNER_REPO_PATTERN.test(raw.sourceRepo)) errors.push('sourceRepo must be a valid GitHub repository name when present');
  } else {
    if (raw.prNumber != null) errors.push(`prNumber must not be set outside pr mode (got mode: ${mode})`);
    if (raw.baseSha != null || raw.headSha != null) errors.push(`baseSha/headSha must not be set outside pr mode (got mode: ${mode})`);
    if (raw.sourceOwner != null || raw.sourceRepo != null) {
      errors.push(`sourceOwner/sourceRepo must not be set outside pr mode (got mode: ${mode}) — only a PR can resolve to a fork`);
    }
  }

  if (mode === 'branch') {
    if (!raw.ref || typeof raw.ref !== 'string') errors.push('ref is required in branch mode');
  } else if (raw.ref != null) {
    errors.push(`ref must not be set outside branch mode (got mode: ${mode})`);
  }

  if (errors.length > 0) throw new AnalysisContextError(errors);

  return Object.freeze({
    owner: raw.owner,
    repo: raw.repo,
    mode,
    ref: mode === 'branch' ? raw.ref : null,
    resolvedSha: raw.resolvedSha.toLowerCase(),
    sourceOwner: mode === 'pr' && raw.sourceOwner ? raw.sourceOwner : raw.owner,
    sourceRepo: mode === 'pr' && raw.sourceRepo ? raw.sourceRepo : raw.repo,
    baseSha: mode === 'pr' && raw.baseSha ? raw.baseSha.toLowerCase() : null,
    headSha: mode === 'pr' && raw.headSha ? raw.headSha.toLowerCase() : null,
    prNumber: mode === 'pr' ? raw.prNumber : null,
  });
}

/**
 * True iff two contexts resolve to the same actual source content: the same
 * source repository (where the SHA was actually found — see sourceOwner/
 * sourceRepo, not necessarily the requested base repository) at the same
 * resolved revision. This is the rule a file/function drill-down request
 * must pass against its parent graph's context before being served — a
 * request that names the same base owner/repo but a *different* resolvedSha
 * (or, for a forked PR, a different actual source repository) must be
 * rejected rather than silently analyzing different content than the graph
 * the user is drilling down from.
 * @param {AnalysisContext} a
 * @param {AnalysisContext} b
 * @returns {boolean}
 */
export function sameRevision(a, b) {
  return (
    a.sourceOwner.toLowerCase() === b.sourceOwner.toLowerCase() &&
    a.sourceRepo.toLowerCase() === b.sourceRepo.toLowerCase() &&
    a.resolvedSha === b.resolvedSha
  );
}

/**
 * Validate that a child request's context (a file or function drill-down)
 * is a legitimate continuation of a parent graph's context. Throws
 * AnalysisContextError with a specific reason rather than returning a bare
 * boolean, since "rejected, but why" matters for a clear API error. Checks
 * both the requested/base repository (owner/repo — provenance/allowlist
 * identity) and the resolved source repository (sourceOwner/sourceRepo —
 * where content is actually fetched from, which can differ from the base
 * for a forked PR) plus the resolved revision.
 * @param {AnalysisContext} parent
 * @param {AnalysisContext} child
 */
export function assertContextPropagation(parent, child) {
  if (parent.owner.toLowerCase() !== child.owner.toLowerCase() || parent.repo.toLowerCase() !== child.repo.toLowerCase()) {
    throw new AnalysisContextError([
      `child request repository (${child.owner}/${child.repo}) does not match parent graph repository (${parent.owner}/${parent.repo})`,
    ]);
  }
  if (
    parent.sourceOwner.toLowerCase() !== child.sourceOwner.toLowerCase() ||
    parent.sourceRepo.toLowerCase() !== child.sourceRepo.toLowerCase()
  ) {
    throw new AnalysisContextError([
      `child request resolves to source repository ${child.sourceOwner}/${child.sourceRepo}, which does not match parent graph's source repository ${parent.sourceOwner}/${parent.sourceRepo} (this can happen across different forked-PR resolutions of the same base repository) — a drill-down request cannot silently switch which repository content is fetched from`,
    ]);
  }
  if (parent.resolvedSha !== child.resolvedSha) {
    throw new AnalysisContextError([
      `child request revision (${child.resolvedSha}) does not match parent graph revision (${parent.resolvedSha}) — a drill-down request cannot silently switch revisions`,
    ]);
  }
}

/**
 * Stable identity string for a context, suitable as part of a cache key
 * (see cacheKey.js) — keyed on the *resolved source* repository
 * (sourceOwner/sourceRepo), since that's what actually determines the
 * fetched content, not the requested base repository (which, for a forked
 * PR, may differ). prNumber still participates so two different PRs against
 * the same base repository that happen to converge on the same source SHA
 * remain distinguishable for provenance/display purposes.
 * @param {AnalysisContext} context
 * @returns {string}
 */
export function contextIdentityKey(context) {
  const prPart = context.mode === 'pr' ? `:pr${context.prNumber}` : '';
  return `${context.sourceOwner.toLowerCase()}/${context.sourceRepo.toLowerCase()}@${context.resolvedSha}${prPart}`;
}
