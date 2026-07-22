// Unit tests for server/lib/dotGraph.js (MOO-70 Commit 3).
//
// Parses real pyan3 DOT output (via the Commit 2 adapter running the
// actual pinned pyan3 binary), not hand-written DOT strings, matching
// this codebase's convention of testing against real tool output.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { WorkspaceManager } from '../server/lib/workspace.js';
import { stagePythonFiles, runPyan3 } from '../server/lib/pyan3Adapter.js';
import { parseDotGraph, extractPyanNodes, extractPyanEdges } from '../server/lib/dotGraph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures/python-symbols');
const PACKAGE_FIXTURES = join(__dirname, 'fixtures/python-symbols-package');
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

async function dotFor(files) {
  const root = await mkdtemp(join(tmpdir(), 'codeflow-dot-test-'));
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-1');
    const absolutePaths = await stagePythonFiles(ws, files);
    const result = await runPyan3({ pythonBin: PYTHON_BIN, workspace: ws, absolutePaths, timeoutMs: 15_000 });
    return result.dot;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('parseDotGraph throws AdapterError(malformed_analyzer_output) on malformed DOT', () => {
  assert.throws(() => parseDotGraph('digraph G { this is not valid dot @@@ '), (err) => {
    assert.equal(err.category, 'malformed_analyzer_output');
    return true;
  });
});

test('extractPyanNodes: nested.py produces one node per module/class/method/function with correct tooltip parsing', async () => {
  const content = readFileSync(join(FIXTURES, 'nested.py'), 'utf8');
  const dot = await dotFor([{ path: 'nested.py', content }]);
  const digraph = parseDotGraph(dot);
  const nodes = extractPyanNodes(digraph);

  assert.equal(nodes.length, 6); // module, Outer, Outer.Inner, Outer.Inner.run, Outer.run, Outer.run.helper

  const moduleNode = nodes.find((n) => n.qualifiedName === 'nested');
  assert.equal(moduleNode.kind, 'module');
  assert.equal(moduleNode.line, null);
  assert.match(moduleNode.path, /nested\.py$/);

  const outerRun = nodes.find((n) => n.qualifiedName === 'nested.Outer.run');
  assert.equal(outerRun.kind, 'method');
  assert.equal(outerRun.parentScope, 'nested.Outer');
  assert.equal(outerRun.line, 6);
  assert.match(outerRun.path, /nested\.py$/);

  const helper = nodes.find((n) => n.qualifiedName === 'nested.Outer.run.helper');
  assert.equal(helper.kind, 'function');
  assert.equal(helper.parentScope, 'nested.Outer.run');
});

test('extractPyanNodes: a whole package run produces nodes for every module', async () => {
  const files = readdirSync(PACKAGE_FIXTURES)
    .filter((name) => name.endsWith('.py'))
    .map((name) => ({ path: join('pkg', name), content: readFileSync(join(PACKAGE_FIXTURES, name), 'utf8') }));
  const dot = await dotFor(files);
  const digraph = parseDotGraph(dot);
  const nodes = extractPyanNodes(digraph);

  assert.ok(nodes.some((n) => n.qualifiedName === 'pkg.mod_a'));
  assert.ok(nodes.some((n) => n.qualifiedName === 'pkg.mod_b'));
  assert.ok(nodes.some((n) => n.qualifiedName === 'pkg.mod_a.Widget'));
});

test('extractPyanEdges: classifies containment as defines and an actual call as uses', async () => {
  const content = readFileSync(join(FIXTURES, 'calls.py'), 'utf8');
  const dot = await dotFor([{ path: 'calls.py', content }]);
  const digraph = parseDotGraph(dot);
  const nodes = extractPyanNodes(digraph);
  const edges = extractPyanEdges(digraph);

  const byQualifiedName = (id) => nodes.find((n) => n.id === id)?.qualifiedName;

  const definesEdges = edges.filter((e) => e.kind === 'defines');
  const usesEdges = edges.filter((e) => e.kind === 'uses');

  // module->Greeter, Greeter->greet, Greeter->build_message
  assert.equal(definesEdges.length, 3);
  // Greeter.greet calls Greeter.build_message
  assert.equal(usesEdges.length, 1);
  assert.equal(byQualifiedName(usesEdges[0].source), 'calls.Greeter.greet');
  assert.equal(byQualifiedName(usesEdges[0].target), 'calls.Greeter.build_message');

  assert.ok(edges.every((e) => e.kind !== 'unknown'));
});
