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

test('workspace.writeFile rejects a battery of malicious path fixtures, none escaping the root', async () => {
  const root = await tempRoot();
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-malicious');
    const fixtures = [
      '../../etc/passwd',
      '../../../../../../etc/shadow',
      '..\\..\\windows\\system32\\config\\sam',
      '/etc/passwd',
      'a/../../b',
    ];
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

test('sweepStaleWorkspaces refuses to run against a root with no ownership marker', async () => {
  const root = await tempRoot();
  try {
    // A directory that exists but was never touched by ensureRoot() --
    // simulates WORKSPACE_ROOT pointed at an already-existing, unrelated
    // directory this codebase never established ownership of.
    await mkdir(join(root, 'instances', 'not-a-real-instance'), { recursive: true });
    const manager = new WorkspaceManager(root);
    manager._instanceDir = join(root, 'instances', manager.bootId); // bypass ensureRoot() entirely
    const result = await manager.sweepStaleWorkspaces();
    assert.equal(result.skipped, 'missing-ownership-marker');
    assert.equal(result.removed, 0);
    // The unrelated directory must survive untouched.
    const info = await stat(join(root, 'instances', 'not-a-real-instance'));
    assert.ok(info.isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sweepStaleWorkspaces never touches files outside instances/, even on an owned root', async () => {
  const root = await tempRoot();
  try {
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
