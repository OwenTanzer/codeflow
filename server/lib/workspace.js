// Request-scoped workspace abstraction — MOO-67 Commit 5, hardened MOO-72
// Commit 6.
//
// A single controlled root (WORKSPACE_ROOT), one normalized subdirectory
// per request, and a cleanup hook. Exists so the later pyan3 (MOO-70) and
// CodeVisualizer (MOO-71) analyzers have one shared place to stage fetched
// source and intermediate artifacts, instead of each inventing its own
// temporary-directory convention.
//
// MOO-72 Commit 6 review findings this file now addresses:
//   - WORKSPACE_ROOT is fully operator-configurable, so an unconditional
//     "delete everything present at startup" sweep could destroy unrelated
//     data if it's ever pointed at a shared/non-dedicated directory. Fixed
//     by an explicit ownership marker (never sweep a root this process
//     didn't establish continuity of ownership over) plus scoping every
//     sweep candidate to a narrow instances/<uuid>/ layout this codebase
//     itself creates -- nothing outside that shape is ever touched.
//   - A rolling deploy (or any two processes sharing a root) can have an
//     old instance still finishing real work while a new one starts --
//     "everything present at my startup is stale" is false in that
//     overlap window. Fixed by a per-process instance directory + PID
//     lock file, checked for actual liveness (process.kill(pid, 0)) before
//     ever removing another instance's directory.
//   - The original stagePythonFiles-style mkdir+writeFile had no symlink
//     awareness at any ancestor level, and no atomic exclusive-create, so
//     a symlink at the final write target (not just an intermediate
//     directory) could be silently followed, and a TOCTOU window existed
//     between checking and writing. Fixed by writeFile()/copyTree() below
//     owning the entire safe-write path themselves (ancestor-walking
//     symlink check + `wx` exclusive create + private file modes) so no
//     caller can bypass containment by forgetting a step.
import { mkdir, rm, writeFile as fsWriteFile, readdir, readFile, lstat, chmod, cp, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNERSHIP_MARKER = '.codeflow-owned-v1';
const INSTANCE_LOCK_FILE = '.codeflow-instance-lock';

export class WorkspaceManager {
  constructor(root) {
    this.root = resolve(root);
    // One per process -- the namespace every workspace this instance
    // creates lives under, and the identity sweepStaleWorkspaces() uses to
    // never touch its own directory.
    this.bootId = randomUUID();
    this._instanceDir = null;
    // PR review finding: ensureRoot() writes the ownership marker on every
    // startup, unconditionally, before sweepStaleWorkspaces() is ever
    // called -- so gating the sweep on "does the marker exist" was
    // checking a fact ensureRoot() itself had just made true, on every
    // startup including the very first one against a freshly-misconfigured
    // shared root. This instead remembers whether the marker already
    // existed *before* this call wrote it, so the sweep can require actual
    // continuity of ownership from a *prior* process, not just its own
    // just-created marker.
    this._rootWasPreviouslyOwned = false;
  }

  /**
   * Fail fast at startup if the root can't actually be created/written to.
   * Also establishes this process's own instance namespace (instances/<bootId>/)
   * and ownership marker -- both required before createRequestWorkspace or
   * sweepStaleWorkspaces can do anything.
   */
  async ensureRoot() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Tighten permissions if the root already existed with looser ones
    // (e.g. operator-created ahead of time) -- best-effort; chmod's mode
    // bits are POSIX semantics and largely a no-op under Windows' NTFS ACL
    // model, meaningful on the real Railway/Linux deployment.
    await chmod(this.root, 0o700).catch(() => {});

    const probe = join(this.root, '.write-check-' + Date.now());
    await mkdir(probe, { recursive: true });
    await rm(probe, { recursive: true, force: true });

    // Ownership stamp: written once, never removed. Checked for
    // *pre-existence* before being written -- sweepStaleWorkspaces() only
    // ever runs when this flag says a *prior* process already established
    // ownership, never on the strength of the marker this same call is
    // about to create. That's what actually protects a freshly-misconfigured
    // shared root: its first-ever ensureRoot() call here sees no marker,
    // remembers that, writes one for *next* time, and this process's own
    // sweep stays a no-op regardless.
    const markerPath = join(this.root, OWNERSHIP_MARKER);
    this._rootWasPreviouslyOwned = await stat(markerPath).then(
      () => true,
      () => false
    );
    if (!this._rootWasPreviouslyOwned) {
      try {
        await fsWriteFile(markerPath, '', { flag: 'wx' });
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }

    const instancesDir = join(this.root, 'instances');
    await mkdir(instancesDir, { recursive: true, mode: 0o700 });
    this._instanceDir = join(instancesDir, this.bootId);
    await mkdir(this._instanceDir, { recursive: true, mode: 0o700 });
    // wx: fails loudly (rather than silently overwriting) in the
    // astronomically unlikely event this bootId already has a lock file --
    // this is the "proof of life" sweepStaleWorkspaces() reads back later.
    await fsWriteFile(join(this._instanceDir, INSTANCE_LOCK_FILE), String(process.pid), { flag: 'wx' });
  }

  /**
   * @param {string} requestId
   * @returns {Promise<{
   *   dir: string,
   *   resolve: (relativePath: string) => string,
   *   writeFile: (relativePath: string, content: string) => Promise<string>,
   *   copyTree: (sourceDir: string) => Promise<void>,
   *   cleanup: () => Promise<void>,
   * }>}
   */
  async createRequestWorkspace(requestId) {
    if (!requestId || !SAFE_ID_PATTERN.test(requestId)) {
      throw new Error('createRequestWorkspace requires a requestId matching ' + SAFE_ID_PATTERN);
    }
    if (!this._instanceDir) {
      throw new Error('createRequestWorkspace called before ensureRoot()');
    }
    const dir = join(this._instanceDir, requestId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return {
      dir,
      resolve: (relativePath) => resolveWithin(dir, relativePath),
      // The only two sanctioned ways to put content into a workspace --
      // see the file-level comment for why raw mkdir/writeFile/cp calls
      // against `dir` are no longer used anywhere in this codebase.
      writeFile: (relativePath, content) => writeIntoWorkspace(dir, relativePath, content),
      copyTree: (sourceDir) => copyIntoWorkspace(dir, sourceDir),
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }

  /**
   * Process-restart cleanup: removes *other* instance directories
   * confirmed not to belong to a still-running process. Never touches
   * anything outside instances/<uuid>/, never touches its own bootId, and
   * refuses to run at all unless a *prior* process already established
   * ownership of this root (see the constructor/ensureRoot() comments --
   * this is `_rootWasPreviouslyOwned`, not merely "does the marker exist
   * right now," which ensureRoot() itself would have just made true on a
   * root's very first startup).
   * @returns {Promise<{removed: number, failed: number, skipped: string|null}>}
   */
  async sweepStaleWorkspaces() {
    if (!this._rootWasPreviouslyOwned) {
      return { removed: 0, failed: 0, skipped: 'root-not-previously-owned' };
    }

    const instancesDir = join(this.root, 'instances');
    let entries;
    try {
      entries = await readdir(instancesDir, { withFileTypes: true });
    } catch {
      return { removed: 0, failed: 0, skipped: null };
    }

    let removed = 0;
    let failed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === this.bootId) continue;
      // Never delete anything that doesn't look like an instance directory
      // this codebase itself creates -- restricts the blast radius to
      // exactly the production UUID shape, nothing else.
      if (!UUID_PATTERN.test(entry.name)) continue;

      const instanceDir = join(instancesDir, entry.name);
      // PR review finding (round 2): treating "no lock file" as "safe to
      // remove" meant a genuinely foreign directory that merely *happened*
      // to have a UUID-shaped name (never created by this codebase, no
      // lock file inside it at all) got swept the moment the root-level
      // ownership marker existed -- which the previous fix made true after
      // only one restart cycle. The root-level marker proves "CodeFlow has
      // run against this root before"; it does NOT prove any given
      // instances/<uuid>/ directory was actually created by CodeFlow. That
      // proof can only come from the directory's own lock file. So a
      // missing/malformed lock file is now its own outcome -- 'unknown
      // provenance' -- and is never removed, full stop, regardless of the
      // root-level marker or how many restarts have happened.
      const state = await instanceLifecycleState(instanceDir);
      if (state !== 'dead') continue; // 'alive' or 'unknown' -- never touched

      try {
        await rm(instanceDir, { recursive: true, force: true });
        removed += 1;
      } catch {
        failed += 1;
      }
    }
    return { removed, failed, skipped: null };
  }
}

/**
 * @param {string} instanceDir
 * @returns {Promise<'alive'|'dead'|'unknown'>}
 *   'alive' -- the lock file names a PID that's still running (or running
 *     under a user we can't signal, treated conservatively as alive).
 *   'dead' -- the lock file names a PID confirmed not running (ESRCH) --
 *     the *only* outcome sweepStaleWorkspaces() will actually remove.
 *   'unknown' -- no lock file, or one that doesn't parse as a PID at all --
 *     this directory's provenance can't be proven, so it's treated the
 *     same as 'alive' (never touched), not the same as 'dead'.
 */
async function instanceLifecycleState(instanceDir) {
  let pid;
  try {
    const lockContent = await readFile(join(instanceDir, INSTANCE_LOCK_FILE), 'utf8');
    pid = Number(lockContent.trim());
  } catch {
    return 'unknown';
  }
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0); // signal 0: no-op, only tests whether the PID exists / we can signal it
    return 'alive';
  } catch (err) {
    if (err.code === 'EPERM') return 'alive'; // exists, owned by another user -- don't touch
    return 'dead'; // ESRCH: confirmed not running
  }
}

function resolveWithin(base, relativePath) {
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`Path escapes workspace root: ${relativePath}`);
  }
  return target;
}

/**
 * Walks every path component from `workspaceDir` down to (and including)
 * `dir`, `lstat`-ing each and throwing if any is a symlink -- not just the
 * immediate parent, since a symlink could be embedded at any depth of a
 * multi-segment relative path. A missing component is fine (nothing to
 * check; mkdir will create it fresh) -- only an *existing* symlink is
 * rejected.
 * @param {string} workspaceDir
 * @param {string} dir
 */
async function assertNoSymlinkInPath(workspaceDir, dir) {
  const segments = [];
  let current = dir;
  while (current === workspaceDir || current.startsWith(workspaceDir + sep)) {
    segments.push(current);
    if (current === workspaceDir) break;
    current = dirname(current);
  }
  for (const segment of segments) {
    let st;
    try {
      st = await lstat(segment);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`Path escapes workspace root: ancestor "${segment}" is a symlink`);
    }
  }
}

/**
 * The one safe way to write a file into a workspace -- see the file-level
 * comment for the TOCTOU/final-target gap this closes relative to a plain
 * mkdir+writeFile.
 * @param {string} workspaceDir
 * @param {string} relativePath
 * @param {string} content
 * @returns {Promise<string>} the absolute path written
 */
async function writeIntoWorkspace(workspaceDir, relativePath, content) {
  const target = resolveWithin(workspaceDir, relativePath);
  const parentDir = dirname(target);
  await assertNoSymlinkInPath(workspaceDir, parentDir);
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  // Re-check after mkdir -- closes the window between the first check and
  // directory creation (cheap; these are small workspace trees).
  await assertNoSymlinkInPath(workspaceDir, parentDir);
  // wx (O_CREAT|O_EXCL): fails if `target` already exists at all, including
  // as a symlink -- POSIX open() with O_EXCL does not follow a symlink at
  // the final path component, it just fails. This is what actually closes
  // the TOCTOU race and the final-target-is-a-symlink case a parent-only
  // realpath check would miss entirely.
  await fsWriteFile(target, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return target;
}

/**
 * The one safe way to copy a local directory tree into a workspace (used
 * by server/routes/analyze.js's local-path analysis, a second
 * workspace-materialization path distinct from writeIntoWorkspace's
 * per-file GitHub-fetched-content path). Rejects -- aborts the whole copy,
 * does not silently skip or dereference -- if the source tree contains any
 * symlink at all, then tightens every copied entry's permissions
 * (fs.cp has no mode-forcing option of its own).
 * @param {string} workspaceDir
 * @param {string} sourceDir
 */
async function copyIntoWorkspace(workspaceDir, sourceDir) {
  await cp(sourceDir, workspaceDir, {
    recursive: true,
    filter: async (src) => {
      const st = await lstat(src);
      if (st.isSymbolicLink()) {
        throw new Error(`workspace copy rejected: source contains a symlink at ${src}`);
      }
      return true;
    },
  });
  await tightenPermissionsRecursively(workspaceDir);
}

async function tightenPermissionsRecursively(dir) {
  await chmod(dir, 0o700).catch(() => {});
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await tightenPermissionsRecursively(full);
    } else {
      await chmod(full, 0o600).catch(() => {});
    }
  }
}
