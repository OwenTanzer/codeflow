// Unit tests for server/lib/workspace.js (MOO-67 Commit 5, hardened MOO-72
// Commit 6: ownership-marker-gated sweep, per-process instance namespace +
// liveness-checked overlap safety, ancestor-walking symlink rejection,
// atomic exclusive-create writes, and real (not synthetic) crash coverage).
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { WorkspaceManager } from '../server/lib/workspace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'codeflow-ws-'));
}

/** Best-effort: some CI/dev environments can't create symlinks/junctions at all. */
async function trySymlink(target, linkPath, type) {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

/**
 * Simulates "a prior process already established ownership of this root"
 * -- pre-writes the marker ensureRoot() itself would otherwise only ever
 * create on a root's first-ever startup, so a test can exercise
 * sweepStaleWorkspaces()'s real decision logic (liveness/UUID-shape
 * checks) rather than only proving "a first-time root's sweep is skipped,"
 * which the dedicated tests below already cover on their own.
 */
async function markRootAsPreviouslyOwned(root) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, '.codeflow-owned-v1'), '');
}

test('ensureRoot creates the configured root and confirms it is writable', async () => {
  const root = join(await tempRoot(), 'nested', 'root');
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const info = await stat(root);
    assert.ok(info.isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createRequestWorkspace creates a subdirectory scoped to this instance, under the root', async () => {
  const root = await tempRoot();
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-123');
    assert.equal(ws.dir, join(root, 'instances', manager.bootId, 'req-123'));
    const info = await stat(ws.dir);
    assert.ok(info.isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createRequestWorkspace requires ensureRoot() to have run first', async () => {
  const root = await tempRoot();
  try {
    const manager = new WorkspaceManager(root);
    await assert.rejects(() => manager.createRequestWorkspace('req-1'), /before ensureRoot/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createRequestWorkspace rejects a requestId with unsafe characters', async () => {
  const root = await tempRoot();
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    await assert.rejects(() => manager.createRequestWorkspace('../escape'));
    await assert.rejects(() => manager.createRequestWorkspace(''));
    await assert.rejects(() => manager.createRequestWorkspace('has/slash'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace.resolve() stays within the workspace and rejects escapes', async () => {
  const root = await tempRoot();
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-456');
    assert.equal(ws.resolve('file.txt'), join(ws.dir, 'file.txt'));
    assert.throws(() => ws.resolve('../../etc/passwd'), /escapes workspace root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanup() removes the request workspace but leaves the root intact', async () => {
  const root = await tempRoot();
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-789');
    await ws.cleanup();
    await assert.rejects(() => stat(ws.dir));
    const rootInfo = await stat(root);
    assert.ok(rootInfo.isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- writeFile: broadened malicious path/ref fixtures ----------------------

// PR review finding: a backslash-separated fixture is not a traversal on
// POSIX at all -- backslash is just an ordinary filename character there
// (not a path separator), so `path.resolve()` treats the whole string as
// one literal filename component, which resolves *inside* the root, not
// outside it. That fixture is only actually a meaningful escape attempt on
// Windows, where backslash is the separator; it was previously asserted
// unconditionally and failed on the Linux CI runner ("Missing expected
// rejection").
test('workspace.writeFile rejects a battery of malicious path fixtures, none escaping the root', async () => {
  const root = await tempRoot();
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-malicious');
    const fixtures = [
      '../../etc/passwd',
      '../../../../../../etc/shadow',
      '/etc/passwd',
      'a/../../b',
    ];
    if (process.platform === 'win32') {
      fixtures.push('..\\..\\windows\\system32\\config\\sam');
    }
    for (const fixture of fixtures) {
      await assert.rejects(() => ws.writeFile(fixture, 'x'), /escapes workspace root/, `expected "${fixture}" to be rejected`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace.writeFile writes real content at a nested relative path', async () => {
  const root = await tempRoot();
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-write');
    const target = await ws.writeFile('pkg/mod.py', 'x = 1\n');
    assert.equal(target, join(ws.dir, 'pkg', 'mod.py'));
    assert.equal(await readFile(target, 'utf8'), 'x = 1\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- concurrent-session isolation --------------------------------------------

test('two concurrent request workspaces never see each other\'s files', async () => {
  const root = await tempRoot();
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const [wsA, wsB] = await Promise.all([
      manager.createRequestWorkspace('req-a'),
      manager.createRequestWorkspace('req-b'),
    ]);
    await wsA.writeFile('secret.py', 'a-only\n');
    await assert.rejects(() => readFile(join(wsB.dir, 'secret.py'), 'utf8'));
    assert.equal(await readFile(join(wsA.dir, 'secret.py'), 'utf8'), 'a-only\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- sweepStaleWorkspaces: ownership + overlap safety ------------------------

// PR review finding: ensureRoot() writes the ownership marker on every
// startup, unconditionally, before sweepStaleWorkspaces() is ever called --
// so a naive "does the marker exist right now" check never actually
// protects anything in the real server/index.js call order (ensureRoot()
// always runs first, always creates the marker, so it's always present by
// the time sweep checks). This is the exact regression test the review
// asked for: the real, unmodified production order (ensureRoot() then
// sweepStaleWorkspaces(), nothing bypassed) against a root that was NOT
// previously owned.
test('sweepStaleWorkspaces refuses to run on a root\'s very first startup (production ensureRoot()->sweep order)', async () => {
  const root = await tempRoot();
  try {
    // A stray UUID-shaped directory that exists before this process ever
    // touches the root -- simulates WORKSPACE_ROOT freshly misconfigured to
    // point at a shared/pre-existing directory that happens to already
    // contain something UUID-named for unrelated reasons.
    const strayDir = join(root, 'instances', '12345678-1234-4123-8123-123456789012');
    await mkdir(strayDir, { recursive: true });

    const manager = new WorkspaceManager(root);
    await manager.ensureRoot(); // the real call -- this is what writes the marker
    const result = await manager.sweepStaleWorkspaces(); // the real call, in the real order

    assert.equal(result.skipped, 'root-not-previously-owned');
    assert.equal(result.removed, 0);
    const info = await stat(strayDir);
    assert.ok(info.isDirectory(), 'a root\'s first-ever startup must never sweep, even though ensureRoot() just wrote the marker');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sweepStaleWorkspaces works normally on a root\'s second startup, once a prior process established ownership', async () => {
  const root = await tempRoot();
  try {
    // First process: this is its own root's first-ever startup, so its own
    // sweep is correctly skipped (covered on its own by the dedicated test
    // above) -- what it *does* do is write the ownership marker for the
    // next process to find.
    const first = new WorkspaceManager(root);
    await first.ensureRoot();
    const firstSweep = await first.sweepStaleWorkspaces();
    assert.equal(firstSweep.skipped, 'root-not-previously-owned');
    assert.equal(firstSweep.removed, 0);

    // A dead instance left behind by that "first process" (simulating it
    // having crashed after this point).
    const deadInstanceDir = join(root, 'instances', '87654321-4321-4321-8321-210987654321');
    await mkdir(deadInstanceDir, { recursive: true });
    await writeFile(join(deadInstanceDir, '.codeflow-instance-lock'), '999999999'); // not a real PID

    // Second process (new manager, same root): the marker already exists
    // from the first process's ensureRoot() call, so this one's sweep must
    // actually run.
    const second = new WorkspaceManager(root);
    await second.ensureRoot();
    const secondSweep = await second.sweepStaleWorkspaces();
    assert.equal(secondSweep.skipped, null);
    assert.equal(secondSweep.removed, 1);
    await assert.rejects(() => stat(deadInstanceDir));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// PR review finding (round 2): the first fix only delayed the destructive
// behavior by one restart cycle -- a pre-existing, genuinely foreign
// instances/<uuid>/ directory (no lock file inside it at all, so nothing
// proves CodeFlow ever created it) survived the *first* startup (root not
// yet marked as owned) but was deleted on the *second* (the first
// startup's ensureRoot() call had, by then, written the ownership marker,
// making the root "previously owned" from the second startup's point of
// view -- even though that "ownership" said nothing about this specific
// directory). This is the exact reproduction from that follow-up,
// run across two full startup cycles as requested.
test('a pre-existing unrelated UUID-shaped directory with no lock file survives across two full startup cycles, not just one', async () => {
  const root = await tempRoot();
  const foreignDir = join(root, 'instances', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  try {
    // Simulates a directory that exists before CodeFlow ever touches this
    // root -- happens to be UUID-shaped, but was never created by this
    // codebase, so it carries no lock file at all.
    await mkdir(foreignDir, { recursive: true });
    await writeFile(join(foreignDir, 'unrelated.txt'), 'not ours');

    // First startup cycle.
    const first = new WorkspaceManager(root);
    await first.ensureRoot();
    const firstSweep = await first.sweepStaleWorkspaces();
    assert.equal(firstSweep.skipped, 'root-not-previously-owned');
    assert.equal(firstSweep.removed, 0);
    assert.equal(await readFile(join(foreignDir, 'unrelated.txt'), 'utf8'), 'not ours', 'must survive the first cycle');

    // Second startup cycle -- the root is now "previously owned" (the
    // first cycle's ensureRoot() wrote the marker), so the sweep actually
    // runs this time. The foreign directory must still survive: it has no
    // lock file, so its provenance is unproven, regardless of the root's
    // own ownership status.
    const second = new WorkspaceManager(root);
    await second.ensureRoot();
    const secondSweep = await second.sweepStaleWorkspaces();
    assert.equal(secondSweep.skipped, null, 'the root is genuinely previously-owned by now, so the sweep should run');
    assert.equal(secondSweep.removed, 0, 'nothing should be removed -- the only candidate has no lock file');
    assert.equal(await readFile(join(foreignDir, 'unrelated.txt'), 'utf8'), 'not ours', 'must survive the second cycle too, not just the first');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sweepStaleWorkspaces never touches files outside instances/, even on an owned root', async () => {
  const root = await tempRoot();
  try {
    await markRootAsPreviouslyOwned(root);
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    // Simulates an operator sharing WORKSPACE_ROOT with unrelated data.
    await writeFile(join(root, 'unrelated-file.txt'), 'do not touch');
    await mkdir(join(root, 'unrelated-dir'), { recursive: true });
    await manager.sweepStaleWorkspaces();
    assert.equal(await readFile(join(root, 'unrelated-file.txt'), 'utf8'), 'do not touch');
    const info = await stat(join(root, 'unrelated-dir'));
    assert.ok(info.isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sweepStaleWorkspaces never removes an overlapping instance that is still alive', async () => {
  const root = await tempRoot();
  try {
    await markRootAsPreviouslyOwned(root);
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const otherBootId = '11111111-2222-4333-8444-555555555555';
    const otherInstanceDir = join(root, 'instances', otherBootId);
    await mkdir(otherInstanceDir, { recursive: true });
    // This test process's own PID -- guaranteed alive for the test's duration.
    await writeFile(join(otherInstanceDir, '.codeflow-instance-lock'), String(process.pid));

    const result = await manager.sweepStaleWorkspaces();
    assert.equal(result.removed, 0);
    const info = await stat(otherInstanceDir);
    assert.ok(info.isDirectory(), 'a live overlapping instance must never be removed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sweepStaleWorkspaces removes an instance whose lock file names a confirmed-dead PID', async () => {
  const root = await tempRoot();
  try {
    await markRootAsPreviouslyOwned(root);
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();

    // Spawn a real, short-lived child process and wait for it to exit, so
    // its PID is genuinely no longer running -- not a fabricated number.
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = child.pid;
    await new Promise((resolvePromise) => child.once('exit', resolvePromise));

    const staleBootId = '99999999-8888-4777-8666-555555555555';
    const staleInstanceDir = join(root, 'instances', staleBootId);
    await mkdir(staleInstanceDir, { recursive: true });
    await writeFile(join(staleInstanceDir, '.codeflow-instance-lock'), String(deadPid));

    const result = await manager.sweepStaleWorkspaces();
    assert.equal(result.removed, 1);
    assert.equal(result.failed, 0);
    await assert.rejects(() => stat(staleInstanceDir));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sweepStaleWorkspaces ignores non-UUID-shaped entries under instances/', async () => {
  const root = await tempRoot();
  try {
    await markRootAsPreviouslyOwned(root);
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const weirdDir = join(root, 'instances', 'not-a-uuid-at-all');
    await mkdir(weirdDir, { recursive: true });
    await manager.sweepStaleWorkspaces();
    const info = await stat(weirdDir);
    assert.ok(info.isDirectory(), 'a non-UUID-shaped entry must never be touched, regardless of liveness');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- real process-crash cleanup (not a synthetic try/finally stand-in) -----

test('a real crashed process\'s orphaned workspace is removed by the next process\'s startup sweep', async () => {
  const root = await tempRoot();
  try {
    const helperScript = join(__dirname, 'fixtures/workspace-crash-helper.mjs');
    // The child creates a real workspace via the real WorkspaceManager, then
    // hard-exits (process.exit) without ever running its own cleanup --
    // exactly what a crash looks like from the next process's perspective.
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [helperScript, root]);
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.once('exit', (code) => {
        if (code !== 0) rejectPromise(new Error(`crash helper failed: ${stderr}`));
        else resolvePromise();
      });
    });

    // A brand-new manager, simulating the replacement process after a restart.
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const instancesDir = join(root, 'instances');
    const beforeSweep = (await readdir(instancesDir)).filter((name) => name !== manager.bootId);
    assert.equal(beforeSweep.length, 1, 'expected exactly one orphaned instance directory from the crashed process');

    const result = await manager.sweepStaleWorkspaces();
    assert.equal(result.removed, 1);
    const afterSweep = (await readdir(instancesDir)).filter((name) => name !== manager.bootId);
    assert.equal(afterSweep.length, 0, 'the crashed process\'s orphaned workspace must be gone');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- symlink rejection: ancestor directory, final target, and copyTree -----

test('workspace.writeFile rejects when an ancestor directory component is a symlink/junction', async (t) => {
  const root = await tempRoot();
  const outside = await tempRoot();
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-symlink-ancestor');

    const linkPath = join(ws.dir, 'pkg');
    const created = await trySymlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    if (!created) {
      t.skip('symlink/junction creation not permitted in this environment');
      return;
    }

    await assert.rejects(() => ws.writeFile('pkg/mod.py', 'x = 1\n'), /symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('workspace.writeFile rejects when the final write target already exists as a symlink', async (t) => {
  const root = await tempRoot();
  const outsideFile = join(await tempRoot(), 'target.txt');
  try {
    await writeFile(outsideFile, 'outside content');
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-symlink-final');

    const linkPath = join(ws.dir, 'mod.py');
    // File symlinks (not junctions) are the only shape that fits "the
    // final target itself is a symlink" -- junctions are directory-only.
    // Some Windows environments without Developer Mode/admin can't create
    // these; skip explicitly rather than fail in that case.
    const created = await trySymlink(outsideFile, linkPath, 'file');
    if (!created) {
      t.skip('file symlink creation not permitted in this environment');
      return;
    }

    await assert.rejects(() => ws.writeFile('mod.py', 'x = 1\n'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dirname(outsideFile), { recursive: true, force: true });
  }
});

test('workspace.copyTree rejects a source tree containing a symlink', async (t) => {
  const root = await tempRoot();
  const sourceRoot = await tempRoot();
  const outside = await tempRoot();
  try {
    await mkdir(join(sourceRoot, 'pkg'), { recursive: true });
    await writeFile(join(sourceRoot, 'pkg', 'clean.py'), 'x = 1\n');
    const linkPath = join(sourceRoot, 'pkg', 'linked');
    const created = await trySymlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    if (!created) {
      t.skip('symlink/junction creation not permitted in this environment');
      return;
    }

    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-copytree-symlink');
    await assert.rejects(() => ws.copyTree(sourceRoot), /symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('workspace.copyTree copies a clean tree and tightens permissions on every entry', async () => {
  const root = await tempRoot();
  const sourceRoot = await tempRoot();
  try {
    await mkdir(join(sourceRoot, 'pkg'), { recursive: true });
    await writeFile(join(sourceRoot, 'pkg', 'clean.py'), 'x = 1\n');

    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-copytree-clean');
    await ws.copyTree(sourceRoot);

    assert.equal(await readFile(join(ws.dir, 'pkg', 'clean.py'), 'utf8'), 'x = 1\n');
    // Mode bits are POSIX semantics -- meaningful on the real Linux
    // deployment, largely a no-op under Windows' NTFS ACL model. Only
    // assert the bits on non-Windows, where they're actually enforced.
    if (process.platform !== 'win32') {
      const fileInfo = await stat(join(ws.dir, 'pkg', 'clean.py'));
      assert.equal(fileInfo.mode & 0o777, 0o600);
      const dirInfo = await stat(join(ws.dir, 'pkg'));
      assert.equal(dirInfo.mode & 0o777, 0o700);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});
