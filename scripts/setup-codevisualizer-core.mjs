#!/usr/bin/env node
// MOO-71 Commit 4: pins and provisions @codevisualizer/core (the
// extracted CodeVisualizer parser core, CodeVisualizer-fork PR #1) from
// the exact commit recorded in codevisualizer-core.lock.json, into a
// gitignored .vendor/codevisualizer/ directory, then builds
// packages/core so package.json's `file:.vendor/codevisualizer/
// packages/core` dependency resolves to a real, built package.
//
// Invoked via the shared "setup:codevisualizer" npm script from BOTH
// `preinstall` and `build` (see package.json) -- PR review: MOO-71
// explicitly requires the same bootstrap from installation AND the
// normal build/deploy path, so correctness doesn't depend on lifecycle
// hooks or ambient local state. A checkout with existing node_modules
// but a deleted, stale, or corrupted .vendor/codevisualizer would
// otherwise let `npm run build` (and therefore a deploy) proceed
// without validating or restoring the pinned dependency -- exactly the
// deployment-state risk this design exists to remove. `preinstall`
// alone only covers `npm install`/`npm ci`; it does not run again for a
// later `npm run build` in the same checkout.
//
// (`preinstall`, not `postinstall`, still matters for the install path
// specifically: npm resolves/links the project's own `dependencies`
// -- including `file:` ones -- *before* postinstall runs, but *after*
// preinstall. Since the vendored target doesn't exist on a fresh
// checkout, the file: dependency can only resolve if this has already
// run, which requires preinstall.)
//
// Unlike scripts/install-pyan3.mjs (pyan3 is an optional runtime
// capability that degrades gracefully), a failure here is NOT
// swallowed: a `file:` dependency pointing at a package that failed to
// build isn't a "degraded but working" state -- it fails the parent
// `npm install`/`npm run build` loudly, matching this ticket's own
// "reject unresolved... rather than analyzing guessed source" spirit.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(readFileSync(join(repoRoot, 'codevisualizer-core.lock.json'), 'utf8'));
const vendorDir = join(repoRoot, '.vendor', 'codevisualizer');

function currentVendoredCommit() {
  if (!existsSync(join(vendorDir, '.git'))) return null;
  try {
    return execFileSync('git', ['-C', vendorDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const alreadyAtPin = currentVendoredCommit() === lock.commit;

if (alreadyAtPin) {
  console.log(`[setup-codevisualizer-core] Already at pinned commit ${lock.commit}, skipping re-clone.`);
} else {
  console.log(`[setup-codevisualizer-core] Cloning ${lock.repository} @ ${lock.commit} into .vendor/codevisualizer ...`);
  rmSync(vendorDir, { recursive: true, force: true });
  execFileSync('git', ['clone', lock.repository, vendorDir], { stdio: 'inherit' });
  execFileSync('git', ['-C', vendorDir, 'checkout', lock.commit], { stdio: 'inherit' });
}

// PR review: verify the final state explicitly rather than trusting
// `git checkout` having exited 0 -- confirm HEAD actually landed on the
// pinned commit (catches e.g. a bad/moved SHA in the lock file, or a
// checkout that "succeeded" without erroring but didn't land where
// expected). Runs regardless of which branch above was taken, so it
// also catches the case where an existing checkout was already at the
// pin but somehow no longer matches by the time we get here.
const finalCommit = currentVendoredCommit();
if (finalCommit !== lock.commit) {
  throw new Error(
    `[setup-codevisualizer-core] After clone/checkout, .vendor/codevisualizer is at ${finalCommit || '(no commit -- not a git checkout)'}, ` +
      `not the pinned commit ${lock.commit}. Refusing to proceed with a mismatched dependency.`
  );
}

console.log('[setup-codevisualizer-core] Installing vendored repo dependencies (npm ci)...');
execFileSync('npm', ['ci'], { cwd: vendorDir, stdio: 'inherit', shell: true });

console.log(`[setup-codevisualizer-core] Building ${lock.workspacePackage}...`);
execFileSync('npm', ['run', 'build', `--workspace=${lock.workspacePackage}`], { cwd: vendorDir, stdio: 'inherit', shell: true });

console.log('[setup-codevisualizer-core] Done.');
