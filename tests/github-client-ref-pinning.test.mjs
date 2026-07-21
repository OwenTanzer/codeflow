// Unit tests for GitHub.scan/scanTree/scanRecursive/getFile/resolvePR's
// ref-pinning behavior (MOO-69 PR #3 review).
//
// Real bug this covers: the browser's GitHub-repo flow used to scan the
// repository first, then independently resolve a commit SHA *afterward*
// and attach it to the resulting GraphIR — two unrelated GitHub requests
// that could each observe a different commit if the branch advanced in
// between, mislabeling whatever content was actually fetched. The fix
// pins every scan/getFile call to one explicitly-resolved SHA passed
// through as a parameter, never re-derived independently. These tests
// mock global fetch to assert the exact URLs requested, rather than
// hitting real GitHub.
import assert from 'node:assert/strict';
import test from 'node:test';

if (!('TreeSitter' in globalThis)) globalThis.TreeSitter = undefined;
if (!('Babel' in globalThis)) globalThis.Babel = undefined;
if (!('acorn' in globalThis)) globalThis.acorn = undefined;

const { GitHub } = await import('../src/analyzer.js');

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  };
}

function withMockedFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    return handler(String(url), options);
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = original;
  });
}

const SHA = 'a'.repeat(40);

test('getFile appends ?ref=<sha> when a ref is supplied, and omits it otherwise', async () => {
  await withMockedFetch(
    () => jsonResponse({ content: Buffer.from('hello').toString('base64'), encoding: 'base64' }),
    async (calls) => {
      await GitHub.getFile('octocat', 'Hello-World', 'a.py', SHA);
      await GitHub.getFile('octocat', 'Hello-World', 'a.py');
      assert.match(calls[0], new RegExp(`ref=${SHA}`));
      assert.doesNotMatch(calls[1], /ref=/);
    }
  );
});

test('scanTree uses the supplied ref directly and skips the extra "look up default branch" request', async () => {
  await withMockedFetch(
    (url) => {
      // A second (redundant) repo-info lookup would hit the bare repo URL,
      // not a /git/trees/ URL -- asserting only one call was made, and it
      // was the tree fetch, is what proves the branch lookup was skipped.
      assert.match(url, /\/git\/trees\//);
      return jsonResponse({ tree: [{ type: 'blob', path: 'a.py', size: 10 }] });
    },
    async (calls) => {
      const files = await GitHub.scanTree('octocat', 'Hello-World', null, [], SHA);
      assert.equal(calls.length, 1, 'expected exactly one request when ref is already resolved');
      assert.match(calls[0], new RegExp(`/git/trees/${SHA}`));
      assert.equal(files.length, 1);
      assert.equal(files[0].path, 'a.py');
    }
  );
});

test('scanTree resolves the default branch first when no ref is supplied (existing behavior preserved)', async () => {
  await withMockedFetch(
    (url) => {
      if (/\/git\/trees\//.test(url)) {
        assert.match(url, /\/git\/trees\/main\b/);
        return jsonResponse({ tree: [] });
      }
      return jsonResponse({ default_branch: 'main' });
    },
    async (calls) => {
      await GitHub.scanTree('octocat', 'Hello-World', null, []);
      assert.equal(calls.length, 2, 'expected a repo-info lookup followed by the tree fetch');
    }
  );
});

test('scanRecursive passes ref through to every directory-listing call', async () => {
  await withMockedFetch(
    () => jsonResponse([{ type: 'file', path: 'a.py', name: 'a.py', size: 5 }]),
    async (calls) => {
      await GitHub.scanRecursive('octocat', 'Hello-World', null, '', 0, [], SHA);
      assert.match(calls[0], new RegExp(`ref=${SHA}`));
    }
  );
});

test('resolvePR extracts the fork owner/repo and head SHA for a cross-repository PR', async () => {
  await withMockedFetch(
    (url) => {
      if (/\/pulls\/42\/files/.test(url)) return jsonResponse([]);
      return jsonResponse({
        head: { sha: SHA, repo: { owner: { login: 'a-contributor' }, name: 'Hello-World' } },
        base: { sha: 'b'.repeat(40) },
      });
    },
    async () => {
      const resolved = await GitHub.resolvePR('octocat', 'Hello-World', 42);
      assert.equal(resolved.owner, 'a-contributor');
      assert.equal(resolved.repo, 'Hello-World');
      assert.equal(resolved.resolvedSha, SHA);
      assert.equal(resolved.baseSha, 'b'.repeat(40));
      assert.ok(resolved.pr);
    }
  );
});

test('resolvePR returns null when the PR head repository is inaccessible (fork deleted)', async () => {
  await withMockedFetch(
    (url) => {
      if (/\/pulls\/42\/files/.test(url)) return jsonResponse([]);
      return jsonResponse({ head: { sha: SHA, repo: null }, base: { sha: 'b'.repeat(40) } });
    },
    async () => {
      const resolved = await GitHub.resolvePR('octocat', 'Hello-World', 42);
      assert.equal(resolved, null);
    }
  );
});
