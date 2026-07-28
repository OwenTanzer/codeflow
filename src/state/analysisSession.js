// Unified analysis-session orchestrator — MOO-72 Commit 1B.
//
// The remaining scope of MOO-72's Commit 1 that "Commit 1A" deferred (1A
// only migrated repository analysis onto the server). Enforces, by
// construction rather than convention, that every file/function
// drill-down request inherits the exact revision context of the
// repository graph it descends from, and that a superseded or cancelled
// request can never write its (now-stale) result into the active view.
//
// A session is created once per top-level repository load (see
// index.html's beginRepositoryLoad) and lives for exactly that one loaded
// revision; navigating repository -> file -> function within it reuses
// the same instance. Replacing it entirely (a new repository/PR/branch
// load) requires the caller to `.cancelAll()` whatever session it's
// replacing -- this module cannot do that itself, since it has no
// reference back to whatever held the previous instance.

/**
 * Read the request fields a child request derives from the parent
 * repository's resolved AnalysisContext -- src/graph-ir/githubContext.js's
 * own shape (owner/repo/resolvedSha/sourceOwner/sourceRepo/prNumber).
 * Matches graphFileClient.js's/graphFunctionClient.js's own
 * buildGraph*Request input fields exactly (owner/repo there are always the
 * requested BASE repository, i.e. context.owner/context.repo, never
 * sourceOwner/sourceRepo).
 * @param {object} context
 */
function deriveRevisionFields(context) {
  return {
    owner: context.owner,
    repo: context.repo,
    resolvedSha: context.resolvedSha,
    pr: context.prNumber,
    sourceOwner: context.sourceOwner,
    sourceRepo: context.sourceRepo,
  };
}

export class AnalysisSession {
  /**
   * @param {object} [input]
   * @param {string} [input.sessionId] - override for tests; defaults to a fresh UUID
   */
  constructor({ sessionId } = {}) {
    this.sessionId = sessionId || crypto.randomUUID();
    this.repositoryContext = null;
    this.repositoryEpoch = 0;
    this._slots = {
      repository: { generation: 0, controller: null },
      file: { generation: 0, controller: null },
      function: { generation: 0, controller: null },
    };
  }

  /**
   * Begin a repository-layer request. Bumps the session-wide epoch,
   * invalidating every child layer at once -- a new repository/PR/branch
   * load supersedes whatever file/function drill-down was in flight
   * under the previous revision, even if this same session instance is
   * reused rather than replaced.
   * @param {string|null} ref
   * @param {number|null} pr
   * @param {string[]} excludePatterns
   * @returns {{params: object, generation: number, signal: AbortSignal, epoch: number}}
   */
  describeRepositoryRequest(ref, pr, excludePatterns) {
    this.repositoryEpoch += 1;
    this.repositoryContext = null;
    this._invalidate('file');
    this._invalidate('function');
    const { generation, signal } = this._begin('repository'); // _begin alone invalidates 'repository' -- no double-bump
    return { params: { ref, pr, excludePatterns, sessionId: this.sessionId }, generation, signal, epoch: this.repositoryEpoch };
  }

  /**
   * Adopt a resolved repository graph's context as this session's
   * revision source of truth -- only if the descriptor that requested it
   * is still current (a stale/superseded resolution is silently
   * rejected, never adopted). The caller must check the boolean return
   * value; a `false` means "ignore this response, it's not current."
   * @param {object} context - the resolved graph's AnalysisContext
   * @param {{generation: number, epoch: number}} descriptor - as returned by describeRepositoryRequest
   * @returns {boolean}
   */
  adoptRepositoryContext(context, { generation, epoch }) {
    if (!this.isCurrent('repository', generation, epoch)) return false;
    this.repositoryContext = Object.freeze({ ...context });
    return true;
  }

  /**
   * @param {string} path
   * @param {string|null} [depth]
   * @returns {{params: object, generation: number, signal: AbortSignal, epoch: number}}
   * @throws {Error} if no repository context has been adopted yet
   */
  describeFileRequest(path, depth) {
    if (!this.repositoryContext) throw new Error('AnalysisSession: no repository context adopted yet');
    this._invalidate('function'); // hierarchical: a new file target invalidates any in-flight function request
    const { generation, signal } = this._begin('file');
    return { params: { ...deriveRevisionFields(this.repositoryContext), path, depth, sessionId: this.sessionId }, generation, signal, epoch: this.repositoryEpoch };
  }

  /**
   * @param {string} path
   * @param {string[]} symbolPath
   * @returns {{params: object, generation: number, signal: AbortSignal, epoch: number}}
   * @throws {Error} if no repository context has been adopted yet
   */
  describeFunctionRequest(path, symbolPath) {
    if (!this.repositoryContext) throw new Error('AnalysisSession: no repository context adopted yet');
    const { generation, signal } = this._begin('function');
    return { params: { ...deriveRevisionFields(this.repositoryContext), path, symbolPath, sessionId: this.sessionId }, generation, signal, epoch: this.repositoryEpoch };
  }

  /**
   * True iff `generation` is still the latest for `layer` under the
   * current epoch -- the one check every .then()/.catch() must perform
   * before writing state.
   * @param {'repository'|'file'|'function'} layer
   * @param {number} generation
   * @param {number} epoch
   * @returns {boolean}
   */
  isCurrent(layer, generation, epoch) {
    const slot = this._slots[layer];
    return epoch === this.repositoryEpoch && slot.generation === generation && !!slot.controller && !slot.controller.signal.aborted;
  }

  /** Abort the in-flight request for one layer without starting a new generation (effect cleanup / pure unmount). */
  abortCurrent(layer) {
    this._invalidate(layer);
  }

  /** Abort every in-flight request across all three layers -- call before replacing or discarding this session. */
  cancelAll() {
    this._invalidate('repository');
    this._invalidate('file');
    this._invalidate('function');
  }

  _begin(layer) {
    this._invalidate(layer);
    const controller = new AbortController();
    const slot = this._slots[layer];
    slot.controller = controller;
    slot.generation += 1;
    return { generation: slot.generation, signal: controller.signal };
  }

  _invalidate(layer) {
    const slot = this._slots[layer];
    if (slot.controller) slot.controller.abort();
    slot.controller = null;
    slot.generation += 1; // bumped even on plain abort -- the old generation can never read as current again
  }
}
