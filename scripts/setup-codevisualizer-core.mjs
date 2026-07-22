#!/usr/bin/env node
// MOO-71 Commit 4: pins and provisions @codevisualizer/core (the
// extracted CodeVisualizer parser core, CodeVisualizer-fork PR #1) from
// the exact commit recorded in codevisualizer-core.lock.json, into a
// gitignored .vendor/codevisualizer/ directory, then builds
// packages/core so package.json's `file:.vendor/codevisualizer/
// packages/core` dependency resolves to a real, built package.
//
// Runs as a `preinstall` script, not `postinstall` -- npm resolves/links
// the project's own `dependencies` (including `file:` ones) *before*
// postinstall runs, but *after* preinstall. Since the vendored target
// doesn't exist on a fresh checkout, the file: dependency can only
// resolve if this has already run, which requires preinstall.
//
// Unlike scripts/install-pyan3.mjs (pyan3 is an optional runtime
// capability that degrades gracefully), a failure here is NOT
// swallowed: a `file:` dependency pointing at a package that failed to
// build isn't a "degraded but working" state -- it fails the parent
// `npm install` loudly, matching this ticket's own "reject unresolved...
// rather than analyzing guessed source" spirit.
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

console.log('[setup-codevisualizer-core] Installing vendored repo dependencies (npm ci)...');
execFileSync('npm', ['ci'], { cwd: vendorDir, stdio: 'inherit', shell: true });

console.log(`[setup-codevisualizer-core] Building ${lock.workspacePackage}...`);
execFileSync('npm', ['run', 'build', `--workspace=${lock.workspacePackage}`], { cwd: vendorDir, stdio: 'inherit', shell: true });

console.log('[setup-codevisualizer-core] Done.');
