// Unit tests for scripts/generate-build-info.mjs's pure computeBuildInfo
// (MOO-72 Commit 8). git calls are injected as functions rather than shelled
// out to a real subprocess, so every path (env override, git success, git
// failure, dirty/clean/unknown) is testable without a real git checkout.
import assert from 'node:assert/strict';
import test from 'node:test';

import { computeBuildInfo } from '../scripts/generate-build-info.mjs';

function throwing() {
  throw new Error('git not available');
}

test('an explicit BUILD_COMMIT_SHA env override wins over git rev-parse, but dirty detection still runs', () => {
  const info = computeBuildInfo({
    version: '1.0.0',
    envCommitSha: 'deadbeef',
    gitRevParseHead: throwing,
    gitStatusPorcelain: () => '',
  });
  assert.equal(info.commitSha, 'deadbeef');
  assert.equal(info.dirty, false);
});

test('falls back to git rev-parse HEAD when no env override is set', () => {
  const info = computeBuildInfo({
    version: '1.0.0',
    envCommitSha: undefined,
    gitRevParseHead: () => 'abc1234\n',
    gitStatusPorcelain: () => '',
  });
  assert.equal(info.commitSha, 'abc1234');
  assert.equal(info.dirty, false);
});

test('a failing git rev-parse (no git binary, no .git directory) yields "unknown", never throws', () => {
  assert.doesNotThrow(() => {
    const info = computeBuildInfo({
      version: '1.0.0',
      envCommitSha: undefined,
      gitRevParseHead: throwing,
      gitStatusPorcelain: throwing,
    });
    assert.equal(info.commitSha, 'unknown');
    // No point checking dirtiness of an unknown commit.
    assert.equal(info.dirty, false);
  });
});

test('a non-empty git status --porcelain marks the build dirty', () => {
  const info = computeBuildInfo({
    version: '1.0.0',
    envCommitSha: undefined,
    gitRevParseHead: () => 'abc1234',
    gitStatusPorcelain: () => ' M some/file.js\n',
  });
  assert.equal(info.dirty, true);
});

test('a failing git status --porcelain yields "unknown" dirtiness, not a false claim of cleanliness', () => {
  const info = computeBuildInfo({
    version: '1.0.0',
    envCommitSha: undefined,
    gitRevParseHead: () => 'abc1234',
    gitStatusPorcelain: throwing,
  });
  assert.equal(info.dirty, 'unknown');
});

test('a missing version falls back to "unknown" rather than undefined/null', () => {
  const info = computeBuildInfo({
    version: undefined,
    envCommitSha: 'deadbeef',
    gitRevParseHead: throwing,
    gitStatusPorcelain: throwing,
  });
  assert.equal(info.version, 'unknown');
});
