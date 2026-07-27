// GitHub-backed analysis pipeline — MOO-67 Commit 6.
//
// Fetches a repository (at a resolved ref: default branch, an explicit
// branch/commit, or a PR's head SHA) via the GitHub REST API using the
// server-held token, then runs it through the same analyzer everything
// else uses. Reuses GitHub/Parser/shouldExcludeFile/buildAnalysisData from
// src/analyzer.js rather than writing a second GitHub client or a second
// exclude-matching implementation.
//
// Deliberately does NOT reuse GitHub.scanTree/getFile as-is: both are
// hardcoded to the repository's default branch (no ref parameter), which
// is exactly the gap this commit needs to close ("validate repository,
// branch, commit, and PR inputs" implies actually fetching at that ref,
// not silently falling back to default). Fetches by blob SHA (from the
// resolved ref's tree) instead of the Contents API's own ref resolution,
// which also sidesteps needing to export more analyzer-internal URL
// helpers just for this.
// MOO-72 Commit 1A review (Blocker A): acorn is real, Node-compatible, pure
// JS with zero native deps -- loading it here (rather than stubbing it to
// undefined like Babel) fixes plain .js/.mjs/.cjs function/class discovery
// and enables AST-based call detection for those files instead of falling
// back to the unstripped token heuristic. It does NOT parse JSX/TS syntax
// on its own -- .jsx/.ts/.tsx files still need Babel to strip that syntax
// first, so Babel stays stubbed; see docs/baseline.md for the full
// remaining-gap writeup (JSX/TS AST parsing).
//
// MOO-72 Commit 1A review (round 2, Blocker A): the guard below is a value
// check (`typeof globalThis.acorn === 'undefined'`), not a presence check
// (`!('acorn' in globalThis)`). server/index.js imports server/routes/
// analyze.js (and transitively server/lib/analyzer-bridge.js, which stubs
// `globalThis.acorn = undefined`) before it imports the route that pulls in
// this file -- so by the time this module runs, `'acorn' in globalThis` is
// already true even though the *value* is still `undefined`. A presence
// check would silently never assign the real module regardless of import
// order; a value check assigns real acorn any time the stub left it
// `undefined`, independent of which bridge module happened to run first.
import * as acorn from 'acorn';

if (typeof globalThis.acorn === 'undefined') globalThis.acorn = acorn;
if (!('Babel' in globalThis)) globalThis.Babel = undefined;

const { GitHub, Parser, shouldExcludeFile, shouldIgnoreDirectory, buildAnalysisData, compileExcludePatterns } = await import(
  '../../src/analyzer.js'
);

// MOO-72 Commit 1A review (round 2, Blocker B): wires the real Node-native
// web-tree-sitter runtime (already used by pythonSymbolIndex.js) into
// `globalThis.TreeSitter`, restoring real tree-sitter CST-based Python
// call-edge detection instead of the token-heuristic fallback. See
// node-tree-sitter-shim.js for the two Node-vs-browser incompatibilities
// this works around.
import { installNodeTreeSitter } from './node-tree-sitter-shim.js';
await installNodeTreeSitter(Parser);

const GITHUB_API = 'https://api.github.com';

export class GithubFetchError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'GithubFetchError';
    this.status = status;
  }
}

/**
 * Set the shared GitHub client's server-held token explicitly. PR review
 * finding: analyzeGithubRepo() (the repository layer's entry point) sets
 * `GitHub.token` as its own first line, but server/routes/graph-file.js
 * calls resolveRef/resolveCommitSha/fetchRawTree/fetchAllContents
 * directly and never called anything that set it — meaning the file
 * layer's GitHub calls ran unauthenticated (GitHub's much lower
 * unauthenticated rate limit, and private repos failing outright) unless
 * some unrelated /api/graph/repository request happened to run first and
 * set the shared module-level token as a side effect. Every caller of
 * these exported helpers must call this explicitly rather than relying on
 * that ordering accident.
 * @param {{token: string}} input
 */
export function configureGithubClient({ token }) {
  GitHub.token = token;
}

async function apiRequest(path, errorMap) {
  // GitHub.request() (shared with the browser) throws a plain Error using
  // errorMap's messages, not GithubFetchError — wrap it so every failure
  // from an actual GitHub call is identifiable as such by the route
  // handler (which maps GithubFetchError to a 502, distinct from a real
  // internal 500). Found this the hard way: a genuinely-expected condition
  // (a PR's fork commit had been deleted/garbage-collected upstream) was
  // surfacing as a generic "Analysis failed" 500 instead of a clear 502
  // with GitHub's own "not found" message, because the thrown Error
  // wasn't an instanceof GithubFetchError.
  try {
    return await GitHub.request(GITHUB_API + path, {}, errorMap);
  } catch (err) {
    throw new GithubFetchError(err.message);
  }
}

/**
 * Resolves which {owner, repo, ref} to actually fetch a tree from.
 *
 * PRs need special handling: a PR's head commit usually lives in a fork
 * (head.repo.full_name != the base owner/repo the caller asked about, e.g.
 * "octocat/Hello-World" PR #10590's head SHA only exists in
 * "angelg84/Hello-World"'s object database). Fetching the base repo's tree
 * API for a fork's SHA 404s -- confirmed against a real forked PR while
 * verifying this endpoint, not assumed. The base repo being allowlisted is
 * still the operative access check: the caller asked for a specific PR
 * *of* that allowlisted repo, and GitHub's own PR data is what tells us
 * which fork/SHA that resolves to.
 */
export async function resolveRef({ owner, repo, ref, pr }) {
  if (pr != null) {
    const prData = await apiRequest(`/repos/${owner}/${repo}/pulls/${pr}`, {
      404: 'Pull request not found',
    });
    const headRepo = prData.head && prData.head.repo;
    if (!headRepo) {
      throw new GithubFetchError('Pull request head repository is inaccessible (fork may have been deleted)');
    }
    return { owner: headRepo.owner.login, repo: headRepo.name, ref: prData.head.sha };
  }
  if (ref) return { owner, repo, ref };
  const repoData = await apiRequest(`/repos/${owner}/${repo}`, {
    404: 'Repository not found',
  });
  return { owner, repo, ref: repoData.default_branch || 'main' };
}

/**
 * Resolve any ref (branch name, tag, or already-a-SHA) to its canonical
 * full commit SHA. GitHub's "get a commit" endpoint accepts all three forms
 * interchangeably and returns the same shape either way, so this is one
 * call regardless of which resolveRef() branch produced `ref` -- unlike
 * resolveRef() itself, which already returns a real commit SHA for pr mode
 * (prData.head.sha) and doesn't need this second call in that case (see
 * analyzeGithubRepo below).
 */
export async function resolveCommitSha(owner, repo, ref) {
  const data = await apiRequest(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
    404: 'Ref not found (branch, tag, or commit does not exist)',
    422: 'Ref not found (branch, tag, or commit does not exist)',
  });
  return data.sha;
}

/**
 * Pure selection logic over an already-fetched Git tree — no network
 * calls, so this is unit-testable directly (see
 * tests/server-github-bridge.test.mjs) instead of only reachable through
 * a real GitHub round-trip.
 *
 * GitHub tree entries already carry each blob's size, so an oversized file
 * is rejected here — before any content is ever fetched/decoded, not
 * after. Individually-oversized files are skipped (excluded from
 * analysis, same as an ignored directory or excluded pattern) rather than
 * failing the whole request; the aggregate is a hard cap instead, since
 * that's the actual memory-exhaustion risk the wildcard allowlist opened
 * up (every accepted blob is fetched into memory and held resident before
 * analysis runs).
 *
 * @param {Array<{type: string, path: string, sha: string, size?: number}>} treeEntries
 * @param {{maxRepoFiles: number, maxFileBytes: number, maxRepoBytes: number, compiledExcludePatterns?: Array}} limits
 * @returns {{files: Array, skippedOversizedFiles: number}}
 * @throws {GithubFetchError} if the aggregate or file-count limit is exceeded
 */
export function selectAnalyzableFiles(treeEntries, { maxRepoFiles, maxFileBytes, maxRepoBytes, compiledExcludePatterns = [] }) {
  const files = [];
  let skippedOversizedFiles = 0;
  let totalBytes = 0;
  for (const entry of treeEntries) {
    if (entry.type !== 'blob') continue;
    const name = entry.path.includes('/') ? entry.path.slice(entry.path.lastIndexOf('/') + 1) : entry.path;
    const folder = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : 'root';
    const pathParts = entry.path.split('/');
    const ignored = pathParts.slice(0, -1).some((part, idx) => {
      const dirPath = pathParts.slice(0, idx + 1).join('/');
      return shouldIgnoreDirectory(dirPath, part, compiledExcludePatterns);
    });
    if (ignored) continue;
    if (shouldExcludeFile(entry.path, name, compiledExcludePatterns)) continue;

    const size = typeof entry.size === 'number' ? entry.size : 0;
    if (size > maxFileBytes) {
      skippedOversizedFiles += 1;
      continue;
    }
    totalBytes += size;
    if (totalBytes > maxRepoBytes) {
      throw new GithubFetchError(
        `Repository content exceeds the configured aggregate size limit of ${maxRepoBytes} bytes ` +
          `(reached ${totalBytes} bytes and counting). Point at a narrower ref, or raise MAX_REPO_BYTES if this is expected.`
      );
    }
    files.push({ path: entry.path, name, folder, sha: entry.sha, size, isCode: Parser.isCode(name) });
  }

  if (files.length > maxRepoFiles) {
    throw new GithubFetchError(
      `Repository has ${files.length} analyzable files, over the configured limit of ${maxRepoFiles}. ` +
        'Point at a narrower ref, or raise MAX_REPO_FILES if this is expected.'
    );
  }
  return { files, skippedOversizedFiles };
}

/**
 * @param {{owner: string, repo: string, resolvedRef: string, maxRepoFiles: number, maxFileBytes: number, maxRepoBytes: number, compiledExcludePatterns?: Array}} options
 * @returns {Promise<{files: Array, skippedOversizedFiles: number}>}
 */
export async function fetchTree({ owner, repo, resolvedRef, maxRepoFiles, maxFileBytes, maxRepoBytes, compiledExcludePatterns = [] }) {
  const data = await apiRequest(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(resolvedRef)}?recursive=1`,
    { 404: 'Ref not found (branch, commit, or PR head does not exist)' }
  );
  if (!data.tree) throw new GithubFetchError('Invalid tree response from GitHub');
  // GitHub caps a recursive tree response at 100,000 entries / 7MB and
  // sets `truncated: true` rather than erroring — silently proceeding
  // would mean the repository layer analyzes an incomplete subset of a
  // very large repository without any indication that happened.
  if (data.truncated) {
    throw new GithubFetchError(
      `Repository tree was truncated by GitHub (too many entries to list recursively in one request) -- ` +
        'the repository is too large to analyze as a whole. Point at a narrower ref/folder if this is expected.'
    );
  }
  return selectAnalyzableFiles(data.tree, { maxRepoFiles, maxFileBytes, maxRepoBytes, compiledExcludePatterns });
}

/**
 * Resolve a repo-relative path to its own Git tree/blob entry by walking
 * the tree non-recursively, one path segment at a time, rather than ever
 * fetching a (possibly-truncated, for a huge monorepo) full recursive
 * tree just to check whether one small path exists. PR review finding:
 * server/routes/graph-file.js previously fetched the *entire* repository
 * tree recursively (fetchRawTree) just to find one requested file/
 * package — for a repository large enough that GitHub truncates that
 * recursive response (100,000 entries / 7MB), a legitimately-existing
 * small file could be missing from the truncated list and falsely
 * reported "not found", even after the whole-repo size/count limits from
 * the prior review round were fixed to no longer reject it outright.
 * @param {{owner: string, repo: string, resolvedRef: string, path: string}} options
 * @returns {Promise<{type: 'blob'|'tree', sha: string, path: string, size?: number}|null>} null when any path segment does not exist
 */
export async function resolvePathEntry({ owner, repo, resolvedRef, path }) {
  const segments = path.split('/').filter(Boolean);
  let currentSha = resolvedRef;
  let currentPath = '';
  let entry = { type: 'tree', sha: resolvedRef, path: '' };
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const data = await apiRequest(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(currentSha)}`, {
      404: 'Ref not found (branch, commit, or PR head does not exist)',
    });
    if (data.truncated) {
      throw new GithubFetchError(
        `Directory listing for "${currentPath || '/'}" was truncated by GitHub's tree API (too many entries) -- ` +
          `cannot reliably resolve "${path}". Point at a narrower path.`
      );
    }
    const found = (data.tree || []).find((e) => e.path === segment);
    if (!found) return null;
    // A non-directory segment appeared before the end of the requested
    // path (e.g. requesting "a/b.py/c" where b.py is a file, not a
    // directory) -- there is nothing further to descend into.
    if (found.type !== 'tree' && i < segments.length - 1) return null;
    currentSha = found.sha;
    currentPath = currentPath ? currentPath + '/' + segment : segment;
    entry = { type: found.type, sha: found.sha, path: currentPath, size: found.size };
  }
  return entry;
}

/**
 * Recursively list every blob under one specific subtree (never the whole
 * repository) — used for a package/directory request. Scoped to that
 * directory's own Git subtree sha, which for any reasonably-sized package
 * is far below GitHub's 100,000-entry/7MB recursive-tree truncation limit
 * even when the repository as a whole is not.
 * @param {{owner: string, repo: string, sha: string, pathPrefix: string}} options
 * @returns {Promise<Array<{type: string, path: string, sha: string, size?: number}>>}
 */
export async function fetchSubtreeFiles({ owner, repo, sha, pathPrefix }) {
  const data = await apiRequest(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(sha)}?recursive=1`, {
    404: 'Ref not found (branch, commit, or PR head does not exist)',
  });
  if (!data.tree) throw new GithubFetchError('Invalid tree response from GitHub');
  if (data.truncated) {
    throw new GithubFetchError(
      `The requested package "${pathPrefix}" has too many entries for GitHub's recursive tree API (truncated). ` +
        'Point at a narrower path.'
    );
  }
  return data.tree.map((entry) => ({ ...entry, path: pathPrefix + '/' + entry.path }));
}

async function fetchBlobContent(owner, repo, sha) {
  const data = await apiRequest(`/repos/${owner}/${repo}/git/blobs/${sha}`, {
    404: 'Blob not found',
  });
  if (data.encoding === 'base64') return Buffer.from(data.content, 'base64').toString('utf8');
  return data.content || '';
}

/** Fetch blob contents with limited concurrency — avoid firing hundreds of requests at once. */
export async function fetchAllContents(owner, repo, files, concurrency = 8) {
  const results = new Array(files.length);
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const i = next++;
      results[i] = await fetchBlobContent(owner, repo, files[i].sha);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return results;
}

/**
 * @param {{owner: string, repo: string, ref: string|null, pr: number|null, excludePatterns?: string[]}} request
 * @param {{githubToken: string, maxRepoFiles: number, maxFileBytes: number, maxRepoBytes: number}} config
 */
export async function analyzeGithubRepo(request, config) {
  configureGithubClient({ token: config.githubToken });

  // MOO-72 Commit 1A: exclude patterns are part of the request (what the
  // user asked to analyze), not server config -- validateRepoRequest has
  // already capped their count/length. compileExcludePatterns expects one
  // delimited string (it was written for a textarea's raw value); joining
  // with newlines reuses its existing parse/normalize/regex-compile logic
  // rather than duplicating it for an array input.
  const rawExcludePatterns = request.excludePatterns || [];
  const compiledExcludePatterns = compileExcludePatterns(rawExcludePatterns.join('\n'));

  const { owner, repo, ref: resolvedRef } = await resolveRef(request);
  // pr mode already resolves to a real commit SHA (the PR's head.sha); any
  // other mode's `ref` may still be a branch/tag name, so it needs this one
  // extra call to pin down the actual commit GraphIR's AnalysisContext (see
  // src/graph-ir/githubContext.js) requires -- resolvedSha must always be a
  // resolved commit SHA, never a branch name. Harmless extra round trip for
  // the existing /api/analyze-repo response, which doesn't consume it.
  const resolvedSha = request.pr != null ? resolvedRef : await resolveCommitSha(owner, repo, resolvedRef);
  const { files, skippedOversizedFiles } = await fetchTree({
    owner,
    repo,
    resolvedRef,
    maxRepoFiles: config.maxRepoFiles,
    maxFileBytes: config.maxFileBytes,
    maxRepoBytes: config.maxRepoBytes,
    compiledExcludePatterns,
  });
  const contents = await fetchAllContents(owner, repo, files);

  const analyzed = [];
  const allFns = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const content = contents[i] || '';
    const layer = Parser.detectLayer(file.path);
    const isContainer = Parser.isScriptContainer(file.path);
    const actualIsCode = file.isCode !== false && (!isContainer || Parser.hasEmbeddedCode(content, file.path));
    const functions = actualIsCode ? Parser.extract(content, file.path) : [];
    analyzed.push({
      path: file.path,
      name: file.name,
      folder: file.folder,
      content,
      functions,
      lines: content ? content.split('\n').length : 0,
      layer,
      // MOO-72 Commit 1A: null, not 0 -- this path never calls
      // GitHub.getCommits per file (that would double GitHub API usage on
      // every scan, under one shared server token), so churn is genuinely
      // unknown here, not "verified zero recent commits."
      churn: null,
      isCode: actualIsCode,
      // MOO-72 Commit 1A review (round 2): carry forward the real parser
      // path Parser.extract actually took, so downstream provenance
      // reporting isn't a post-hoc guess from ambient globals -- see
      // card/lib/collect.js's identical field for the fuller rationale.
      parserProvenance: functions.provenance,
    });
    if (actualIsCode) {
      for (const fn of functions) allFns.push({ ...fn, folder: file.folder, layer });
    }
  }

  const result = await buildAnalysisData({
    analyzed,
    allFns,
    // The normalized (deduped, trimmed) raw pattern strings, matching what
    // buildAnalysisData already expects for reporting -- compiledExcludePatterns
    // above is the regex-bearing form used for actual filtering upstream.
    excludePatterns: compiledExcludePatterns.map((p) => p.raw),
    progress() {},
    yieldFn: async () => {},
  });

  return {
    result,
    resolvedRef,
    fileCount: files.length,
    skippedOversizedFiles,
    // Resolved source identity for GraphIR's AnalysisContext -- sourceOwner/
    // sourceRepo differ from the request's owner/repo only for a forked PR
    // (see resolveRef's own doc comment); every other mode has them equal.
    sourceOwner: owner,
    sourceRepo: repo,
    resolvedSha,
  };
}
