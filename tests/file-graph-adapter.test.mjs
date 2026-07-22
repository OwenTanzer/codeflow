// Unit tests for src/adapters/fileGraphAdapter.js (MOO-70 Commit 5).
//
// Runs the real full pipeline end-to-end (tree-sitter -> pyan3 subprocess
// -> DOT parse -> join -> adapt), matching
// tests/repository-graph-adapter.test.mjs's own convention of testing
// against real analyzer output rather than hand-built joined-data fakes.
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
import { indexPythonSymbols } from '../server/lib/pythonSymbolIndex.js';
import { joinPyanToSymbols } from '../server/lib/pyanSymbolJoin.js';
import { adaptFileAnalysis } from '../src/adapters/fileGraphAdapter.js';
import { validateGraphIR } from '../src/graph-ir/graphIR.js';
import { normalizeContext } from '../src/graph-ir/githubContext.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures/python-symbols');
const PACKAGE_FIXTURES = join(__dirname, 'fixtures/python-symbols-package');
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

const SHA = 'a'.repeat(40);
const CONTEXT = normalizeContext({ owner: 'octocat', repo: 'Hello-World', resolvedSha: SHA });
const ANALYZER = { name: 'codeflow-pyan3-adapter', version: '1.0.0' };

function fileOf(name) {
  return { path: name, content: readFileSync(join(FIXTURES, name), 'utf8') };
}

async function adaptFixture(files, { requestPath, skipPyan = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codeflow-adapter-test-'));
  try {
    const manager = new WorkspaceManager(root);
    await manager.ensureRoot();
    const ws = await manager.createRequestWorkspace('req-1');
    const absolutePaths = await stagePythonFiles(ws, files);

    let pyanNodes = [];
    let pyanEdges = [];
    if (!skipPyan) {
      const result = await runPyan3({ pythonBin: PYTHON_BIN, workspace: ws, absolutePaths, timeoutMs: 15_000 });
      const digraph = parseDotGraph(result.dot);
      pyanNodes = extractPyanNodes(digraph);
      pyanEdges = extractPyanEdges(digraph);
    }

    const symbolEntries = [];
    for (const file of files) {
      const indexed = await indexPythonSymbols({ path: file.path, content: file.content });
      symbolEntries.push(...indexed.entries);
    }

    const joined = joinPyanToSymbols({ pyanNodes, pyanEdges, symbolEntries, workspaceDir: ws.dir });
    return adaptFileAnalysis({
      context: CONTEXT,
      requestPath: requestPath || files[0].path,
      joined,
      analyzer: ANALYZER,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('nested.py adapts into a schema-valid file GraphIR with nested groups', async () => {
  const graph = await adaptFixture([fileOf('nested.py')]);
  const { valid, errors } = validateGraphIR(graph);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
  assert.equal(graph.layer, 'file');
  assert.equal(graph.confidence, 1);

  const outerGroup = graph.groups.find((g) => g.label === 'Outer');
  const innerGroup = graph.groups.find((g) => g.label === 'Inner');
  assert.ok(outerGroup);
  assert.equal(outerGroup.parentGroupId, null);
  assert.equal(innerGroup.parentGroupId, outerGroup.id);

  const innerRunNode = graph.nodes.find((n) => n.coordinate && n.coordinate.symbolPath.join('.') === 'Outer.Inner.run');
  assert.equal(innerRunNode.groupId, innerGroup.id);
});

test('repeated_names.py: distinct qualifiedNames stay distinct nodes with distinct groups', async () => {
  const graph = await adaptFixture([fileOf('repeated_names.py')]);
  assert.equal(validateGraphIR(graph).valid, true);

  const alphaGroup = graph.groups.find((g) => g.label === 'Alpha');
  const betaGroup = graph.groups.find((g) => g.label === 'Beta');
  assert.notEqual(alphaGroup.id, betaGroup.id);

  const runNodes = graph.nodes.filter((n) => n.coordinate && n.coordinate.symbolPath[n.coordinate.symbolPath.length - 1] === 'run');
  assert.equal(runNodes.length, 2);
  assert.notEqual(runNodes[0].groupId, runNodes[1].groupId);
});

test('calls.py: a real uses GraphEdge survives end-to-end', async () => {
  const graph = await adaptFixture([fileOf('calls.py')]);
  assert.equal(validateGraphIR(graph).valid, true);

  const usesEdges = graph.edges.filter((e) => e.kind === 'uses');
  assert.equal(usesEdges.length, 1);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get(usesEdges[0].source).label, 'greet');
  assert.equal(byId.get(usesEdges[0].target).label, 'build_message');
});

test('package fixture: cross-file uses edge survives end-to-end', async () => {
  const files = readdirSync(PACKAGE_FIXTURES)
    .filter((name) => name.endsWith('.py'))
    .map((name) => ({ path: join('pkg', name), content: readFileSync(join(PACKAGE_FIXTURES, name), 'utf8') }));
  const graph = await adaptFixture(files, { requestPath: 'pkg' });
  assert.equal(validateGraphIR(graph).valid, true);

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const crossFileEdge = graph.edges.find(
    (e) => e.kind === 'uses' && byId.get(e.source)?.coordinate?.symbolPath.join('.') === 'make_widget'
  );
  assert.ok(crossFileEdge);
  assert.equal(byId.get(crossFileEdge.target).label, 'Widget');
});

test('symbolOnly scenario: pyan3 unavailable for a file still yields a partial-confidence graph, not a failure', async () => {
  const graph = await adaptFixture([fileOf('syntax_error.py')], { skipPyan: true });
  const { valid, errors } = validateGraphIR(graph);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
  assert.ok(graph.confidence < 1);

  const solo = graph.nodes.find((n) => n.label === 'solo');
  assert.ok(solo.coordinate);
  assert.equal(solo.metadata.noRelationshipData, true);
  assert.equal(graph.edges.length, 0);
});

test('external_refs.py: no fabricated node for the unresolvable external target', async () => {
  const graph = await adaptFixture([fileOf('external_refs.py')]);
  assert.equal(validateGraphIR(graph).valid, true);
  assert.equal(graph.nodes.length, 3);
  assert.ok(graph.nodes.every((n) => n.hints.colorRole === 'default'));
});

test('rootCoordinate names the requested file/package path', async () => {
  const graph = await adaptFixture([fileOf('nested.py')]);
  assert.equal(graph.rootCoordinate.path, 'nested.py');
  assert.equal(graph.rootCoordinate.symbolKind, 'module');
  assert.equal(graph.rootCoordinate.range, null);
});
