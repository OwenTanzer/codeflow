// Helper process for tests/server-workspace.test.mjs's real process-crash
// cleanup test (MOO-72 Commit 6). Creates a real workspace via the real
// WorkspaceManager, writes a file into it to prove it's genuinely
// populated, then exits *without* ever calling cleanup() -- simulating
// what a crashed process leaves behind, as seen by the next process's
// startup sweep. Deliberately exits 0 (a controlled simulation, not an
// actual uncaught crash) so the parent test can distinguish "the helper
// ran successfully and then abandoned its workspace on purpose" from "the
// helper itself failed for an unrelated reason."
import { WorkspaceManager } from '../../server/lib/workspace.js';

const root = process.argv[2];
if (!root) {
  console.error('usage: workspace-crash-helper.mjs <root>');
  process.exit(1);
}

const manager = new WorkspaceManager(root);
await manager.ensureRoot();
const ws = await manager.createRequestWorkspace('crash-test');
await ws.writeFile('proof.txt', 'this workspace was real');
// No ws.cleanup() call -- intentional.
process.exit(0);
