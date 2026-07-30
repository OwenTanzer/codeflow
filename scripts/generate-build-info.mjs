// Generates build-info.json — MOO-72 Commit 8.
//
// One shared source of version/commit provenance, consumed by both the
// server (server/index.js reads this file directly at startup) and the
// frontend (fetches it from the server's /healthz response) -- not two
// independently-computed values that could drift. A Vite `define` alone
// would not work here: server/index.js runs directly via `node
// server/index.js` (see package.json's `start` script), never processed
// by Vite, so a browser-bundle-only injection would never reach it.
//
// Run as part of `npm run build` (see package.json), before `vite build`
// so the file exists by the time anything might want it; also safe to run
// standalone.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pure computation, injected with the git calls (and env) so it's testable
 * without a real subprocess or a real package.json on disk.
 * @param {object} input
 * @param {string} input.version - from package.json
 * @param {string} [input.envCommitSha] - process.env.BUILD_COMMIT_SHA
 * @param {() => string} input.gitRevParseHead - throws on failure
 * @param {() => string} input.gitStatusPorcelain - throws on failure
 * @returns {{version: string, commitSha: string, dirty: boolean|'unknown'}}
 */
export function computeBuildInfo({ version, envCommitSha, gitRevParseHead, gitStatusPorcelain }) {
  // Explicit env override first, so any CI/deployment environment can
  // inject a known-good value without relying on git metadata being
  // present in the build context at all. Railway's RAILWAY_GIT_COMMIT_SHA
  // is one possible source for this, but it is not guaranteed for every
  // build type, so it is read as one option a deployment can set, not
  // assumed always-present.
  let commitSha = envCommitSha || '';
  let dirty = false;

  if (!commitSha) {
    // Caught, never uncaught -- a missing git binary or a build context
    // with no .git directory (e.g. a tarball-only deploy) must not fail
    // the build over a provenance nicety.
    try {
      commitSha = gitRevParseHead().trim();
    } catch {
      commitSha = 'unknown';
    }
  }

  if (commitSha !== 'unknown') {
    try {
      const status = gitStatusPorcelain();
      dirty = status.trim().length > 0;
    } catch {
      // Unknown, not false -- a failed check should not assert
      // cleanliness it never actually verified. Surfaced only
      // informationally either way; production builds should come from a
      // clean CI/Railway checkout per docs/deployment.md, not enforced as
      // a hard build-time gate here.
      dirty = 'unknown';
    }
  }

  return { version: version || 'unknown', commitSha, dirty };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(__dirname, '..');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

  const info = computeBuildInfo({
    version: pkg.version,
    envCommitSha: process.env.BUILD_COMMIT_SHA,
    gitRevParseHead: () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }),
    gitStatusPorcelain: () => execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }),
  });

  const buildInfo = { ...info, builtAt: new Date().toISOString() };
  writeFileSync(join(repoRoot, 'build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n');
  console.log('[generate-build-info] wrote build-info.json:', buildInfo);
}
