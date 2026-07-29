// Unit tests for server/lib/github-analyzer-bridge.js's pure tree-selection
// logic (MOO-67 Commit 6 -- PR review fixup: byte limits). No network --
// operates directly on synthetic Git tree entries, same shape the GitHub
// Trees API returns.
import assert from 'node:assert/strict';
import test from 'node:test';

import { selectAnalyzableFiles, GithubFetchError, verifyGithubReachable } from '../server/lib/github-analyzer-bridge.js';

const LIMITS = { maxRepoFiles: 500, maxFileBytes: 1024, maxRepoBytes: 4096 };

function blob(path, size, sha = 'sha-' + path) {
  return { type: 'blob', path, sha, size };
}

test('selectAnalyzableFiles accepts files within both the per-file and aggregate byte limits', () => {
  const { files, skippedOversizedFiles } = selectAnalyzableFiles(
    [blob('a.js', 100), blob('b.js', 200)],
    LIMITS
  );
  assert.equal(files.length, 2);
  assert.equal(skippedOversizedFiles, 0);
});

test('selectAnalyzableFiles skips (does not fail the request for) a single oversized file', () => {
  // .bin isn't a recognized code file type at all, so it would be
  // excluded before ever reaching the size check -- use an otherwise
  // includable extension (.js) to isolate the size-based skip specifically.
  const { files, skippedOversizedFiles } = selectAnalyzableFiles(
    [blob('huge.js', 2048), blob('small.js', 100)],
    LIMITS
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'small.js');
  assert.equal(skippedOversizedFiles, 1);
});

test('selectAnalyzableFiles rejects the whole request when the aggregate size is exceeded', () => {
  // Each file is under the 1024-byte per-file cap individually, but five of
  // them sum past the 4096-byte aggregate cap.
  const underPerFileCapButNotAggregate = [
    blob('a.js', 1000), blob('b.js', 1000), blob('c.js', 1000), blob('d.js', 1000), blob('e.js', 1000),
  ];
  assert.throws(
    () => selectAnalyzableFiles(underPerFileCapButNotAggregate, LIMITS),
    (err) => {
      assert.ok(err instanceof GithubFetchError);
      assert.match(err.message, /aggregate size limit/);
      return true;
    }
  );
});

test('selectAnalyzableFiles rejects the whole request when the file-count limit is exceeded', () => {
  const entries = Array.from({ length: 5 }, (_, i) => blob(`file-${i}.js`, 10));
  assert.throws(
    () => selectAnalyzableFiles(entries, { ...LIMITS, maxRepoFiles: 3 }),
    (err) => {
      assert.ok(err instanceof GithubFetchError);
      assert.match(err.message, /analyzable files, over the configured limit/);
      return true;
    }
  );
});

// MOO-72 Commit 1A review (Blocker B): server/lib/config.js's MAX_REPO_FILES
// default moved 500 -> 750 to match the old client-side browser path's
// ANALYSIS_LIMITS.repoMax ceiling -- but that old path silently sampled down
// to 750 files with a warning, while this route hard-rejects past the limit.
// These boundary tests pin the new limit's edges directly (passing
// maxRepoFiles: 750 explicitly, per this file's existing convention of never
// reading from loadConfig) so a future accidental config change is caught
// here rather than only in server-config.test.mjs's single defaults check.
test('selectAnalyzableFiles accepts exactly 500 files under the new 750 limit', () => {
  const entries = Array.from({ length: 500 }, (_, i) => blob(`file-${i}.js`, 10));
  const { files } = selectAnalyzableFiles(entries, { ...LIMITS, maxRepoFiles: 750, maxRepoBytes: 1024 * 1024 });
  assert.equal(files.length, 500);
});

test('selectAnalyzableFiles accepts 501 files under the new 750 limit (previously rejected at 500)', () => {
  const entries = Array.from({ length: 501 }, (_, i) => blob(`file-${i}.js`, 10));
  const { files } = selectAnalyzableFiles(entries, { ...LIMITS, maxRepoFiles: 750, maxRepoBytes: 1024 * 1024 });
  assert.equal(files.length, 501);
});

test('selectAnalyzableFiles accepts exactly 750 files (the new limit itself)', () => {
  const entries = Array.from({ length: 750 }, (_, i) => blob(`file-${i}.js`, 10));
  const { files } = selectAnalyzableFiles(entries, { ...LIMITS, maxRepoFiles: 750, maxRepoBytes: 1024 * 1024 });
  assert.equal(files.length, 750);
});

test('selectAnalyzableFiles rejects 751 files (one over the new limit)', () => {
  const entries = Array.from({ length: 751 }, (_, i) => blob(`file-${i}.js`, 10));
  assert.throws(
    () => selectAnalyzableFiles(entries, { ...LIMITS, maxRepoFiles: 750, maxRepoBytes: 1024 * 1024 }),
    (err) => {
      assert.ok(err instanceof GithubFetchError);
      assert.match(err.message, /751 analyzable files, over the configured limit of 750/);
      return true;
    }
  );
});

test('selectAnalyzableFiles ignores non-blob tree entries (directories, submodules)', () => {
  const { files } = selectAnalyzableFiles(
    [
      { type: 'tree', path: 'src', sha: 'sha-src' },
      { type: 'commit', path: 'vendor/submodule', sha: 'sha-sub' },
      blob('src/index.js', 50),
    ],
    LIMITS
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/index.js');
});

test('selectAnalyzableFiles treats a missing size as zero rather than throwing', () => {
  const { files } = selectAnalyzableFiles([{ type: 'blob', path: 'a.js', sha: 'sha-a' }], LIMITS);
  assert.equal(files.length, 1);
  assert.equal(files[0].size, 0);
});

test('selectAnalyzableFiles still applies ignored-directory and excluded-file rules', () => {
  const { files } = selectAnalyzableFiles(
    [blob('node_modules/pkg/index.js', 10), blob('a.exe', 10), blob('src/app.js', 10)],
    LIMITS
  );
  assert.deepEqual(files.map((f) => f.path), ['src/app.js']);
});

// MOO-72 Commit 5: verifyGithubReachable is used for a periodic
// dependency/runtime health check -- hermetically mocked here (no real
// token, no real network call) via the injectable fetchImpl/apiBase, per
// the PR review finding that a hard-coded GITHUB_API/real-token dependency
// would make this untestable in CI.
function fakeFetch(handler) {
  return async (url, init) => handler(url, init);
}

test('verifyGithubReachable: a 200 response reports ok', async () => {
  const result = await verifyGithubReachable({
    token: 'irrelevant',
    apiBase: 'https://fake.example',
    fetchImpl: fakeFetch(async () => ({ ok: true, status: 200 })),
  });
  assert.deepEqual(result, { ok: true, detail: null });
});

test('verifyGithubReachable: a 401 is distinguished from other failures', async () => {
  const result = await verifyGithubReachable({
    token: 'bad-token',
    apiBase: 'https://fake.example',
    fetchImpl: fakeFetch(async () => ({ ok: false, status: 401 })),
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /rejected the configured token/);
});

test('verifyGithubReachable: a non-401 non-2xx status is reported with its own detail', async () => {
  const result = await verifyGithubReachable({
    token: 'irrelevant',
    apiBase: 'https://fake.example',
    fetchImpl: fakeFetch(async () => ({ ok: false, status: 503 })),
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /503/);
});

test('verifyGithubReachable: a rejected fetch (network failure) is reported distinctly from a 401', async () => {
  const result = await verifyGithubReachable({
    token: 'irrelevant',
    apiBase: 'https://fake.example',
    fetchImpl: fakeFetch(async () => { throw new TypeError('fetch failed'); }),
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /Could not reach the GitHub API/);
});

test('verifyGithubReachable: an aborted (timed-out) request is reported distinctly', async () => {
  const result = await verifyGithubReachable({
    token: 'irrelevant',
    apiBase: 'https://fake.example',
    fetchImpl: fakeFetch(async (url, init) => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /did not respond within/);
});

test('verifyGithubReachable: sends the token as a Bearer header against the injected apiBase', async () => {
  let capturedUrl, capturedAuth;
  await verifyGithubReachable({
    token: 'my-token',
    apiBase: 'https://fake.example',
    fetchImpl: fakeFetch(async (url, init) => {
      capturedUrl = url;
      capturedAuth = init.headers.Authorization;
      return { ok: true, status: 200 };
    }),
  });
  assert.equal(capturedUrl, 'https://fake.example/rate_limit');
  assert.equal(capturedAuth, 'Bearer my-token');
});
