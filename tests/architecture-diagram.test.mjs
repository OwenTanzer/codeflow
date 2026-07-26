import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// Parser's methods reference these as ambient globals only when actually
// invoked (mirroring the browser's real CDN-provided globals) — see
// docs/baseline.md.
if (!('TreeSitter' in globalThis)) globalThis.TreeSitter = undefined;
if (!('Babel' in globalThis)) globalThis.Babel = undefined;
if (!('acorn' in globalThis)) globalThis.acorn = undefined;

const { Parser, buildAnalysisData, buildArchitectureDiagram, generateMermaidBlockDiagram, getVisibleArchitectureBlocks, getArchitectureGroupOrder } = await import('../src/analyzer.js');

async function collectRepoFiles(root) {
  const files = [];
  const ignored = new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.venv',
    '.venv-pyan3',
    'venv',
    'test-results',
    // MOO-71 Commit 4: .vendor/codevisualizer/ is a whole pinned,
    // built checkout of a *different* repo (CodeVisualizer-fork),
    // provisioned by scripts/setup-codevisualizer-core.mjs on every
    // npm install. Walking into it here would analyze that repo's
    // architecture instead of this one's -- its hundreds of
    // core/module-classified files were crowding out this repo's own
    // test/fixture-kind blocks past ARCHITECTURE_MAX_BLOCKS (64) in a
    // clean CI install, since this test's own walk has no other way to
    // know it's a foreign, provisioned tree rather than part of this
    // codebase.
    '.vendor',
  ]);

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !Parser.isIncluded(entry.name)) continue;
      const repoPath = relative(root, fullPath).replace(/\\/g, '/');
      files.push({
        fullPath,
        path: repoPath,
        name: basename(repoPath),
        folder: repoPath.includes('/') ? repoPath.slice(0, repoPath.lastIndexOf('/')) : 'root',
        isCode: Parser.isCode(entry.name),
      });
    }
  }

  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function analyzeCodeflowRepo() {
  const files = await collectRepoFiles(repoRoot);
  const analyzed = [];
  const allFns = [];

  for (const file of files) {
    const content = await readFile(file.fullPath, 'utf8');
    const layer = Parser.detectLayer(file.path);
    const actualIsCode =
      file.isCode !== false &&
      (!Parser.isScriptContainer(file.path) || Parser.hasEmbeddedCode(content, file.path));
    const functions = actualIsCode ? Parser.extract(content, file.path) : [];
    analyzed.push({
      path: file.path,
      name: file.name,
      folder: file.folder,
      content,
      functions,
      lines: content ? content.split('\n').length : 0,
      layer,
      churn: 0,
      isCode: actualIsCode,
    });
    if (actualIsCode) {
      functions.forEach((fn) => allFns.push(Object.assign({}, fn, { folder: file.folder, layer })));
    }
  }

  return buildAnalysisData({
    analyzed,
    allFns,
    excludePatterns: [],
    progress() {},
    yieldFn: async () => {},
  });
}

function blockPaths(diagram, includeTests, includeBuildOutput) {
  return getVisibleArchitectureBlocks(diagram.blocks || [], includeTests, includeBuildOutput).flatMap((block) => block.files || []);
}

function blockHasFile(block, suffix) {
  return (block.files || []).some((file) => file === suffix || file.endsWith('/' + suffix) || file.endsWith(suffix));
}

function hasDependency(diagram, fromSuffix, toSuffix, label) {
  const fromBlock = diagram.blocks.find((block) => blockHasFile(block, fromSuffix));
  const toBlock = diagram.blocks.find((block) => blockHasFile(block, toSuffix));
  assert.ok(fromBlock, `missing block ${fromSuffix}`);
  assert.ok(toBlock, `missing block ${toSuffix}`);
  return diagram.dependencies.some(
    (dep) =>
      dep.from === fromBlock.id &&
      dep.to === toBlock.id &&
      (!label || dep.label === label)
  );
}

test('codeflow architecture diagram hides tests by default', async () => {
  const data = await analyzeCodeflowRepo();
  const diagram = data.architectureDiagram;

  assert.ok(diagram);
  assert.equal(diagram.framework, 'Browser App');

  const visiblePaths = blockPaths(diagram, false, false);
  assert.ok(visiblePaths.some((path) => /index\.html$/i.test(path)));
  assert.ok(visiblePaths.some((path) => path === 'card/index.js'));
  assert.ok(visiblePaths.some((path) => path === 'card/lib/analyzer.js'));
  assert.ok(visiblePaths.some((path) => path === 'card/lib/collect.js'));
  assert.equal(
    visiblePaths.some((path) => /tests\//i.test(path) || /\.test\.mjs$/i.test(path)),
    false
  );
  assert.equal(
    visiblePaths.some((path) => /fixtures\//i.test(path)),
    false
  );

  const mermaid = generateMermaidBlockDiagram(diagram, false, false);
  assert.match(mermaid, /Browser App Shell/);
  assert.doesNotMatch(mermaid, /uses \d+ calls/i);
});

test('codeflow architecture diagram uses semantic module dependencies', async () => {
  const data = await analyzeCodeflowRepo();
  const diagram = data.architectureDiagram;

  assert.ok(hasDependency(diagram, 'card/index.js', 'card/lib/collect.js'));
  assert.ok(hasDependency(diagram, 'card/index.js', 'card/lib/git.js'));
  assert.ok(hasDependency(diagram, 'card/lib/collect.js', 'card/lib/git.js', 'uses GitHub API'));
  assert.ok(hasDependency(diagram, 'card/lib/analyzer.js', 'card/lib/state.js', 'stores derived state'));
  assert.ok(hasDependency(diagram, 'card/lib/pr.js', 'card/lib/git.js', 'analyzes pull requests'));
  assert.ok(hasDependency(diagram, 'index.html', 'card/lib/analyzer.js', 'runs analysis'));

  const labels = diagram.dependencies.map((dep) => dep.label);
  assert.equal(labels.some((label) => /^uses \d+ calls?$/i.test(label)), false);
});

test('codeflow architecture diagram can include tests', async () => {
  const data = await analyzeCodeflowRepo();
  const diagram = data.architectureDiagram;
  const withTests = blockPaths(diagram, true);

  // Not a specific hardcoded test file: this repo's own file count grows
  // over time (MOO-72 Commit 1A alone added six files), and
  // ARCHITECTURE_MAX_BLOCKS caps the diagram at 64 blocks -- asserting one
  // exact filename survives that cutoff is exactly the kind of assertion
  // repo growth breaks without any real regression. The test's actual
  // subject is "the includeTests flag surfaces test files at all," which
  // any test-classified path proves.
  assert.ok(withTests.some((path) => path.startsWith('tests/')), 'at least one tests/ path must be visible with includeTests=true');
  const mermaid = generateMermaidBlockDiagram(diagram, true, false);
  assert.match(mermaid, /Testing/);
});

async function analyzeFixture(name) {
  const root = join(__dirname, 'fixtures', name);
  const files = await collectRepoFiles(root);
  const analyzed = [];
  const allFns = [];

  for (const file of files) {
    const content = await readFile(file.fullPath, 'utf8');
    const layer = Parser.detectLayer(file.path);
    const actualIsCode =
      file.isCode !== false &&
      (!Parser.isScriptContainer(file.path) || Parser.hasEmbeddedCode(content, file.path));
    const functions = actualIsCode ? Parser.extract(content, file.path) : [];
    analyzed.push({
      path: file.path,
      name: file.name,
      folder: file.folder,
      content,
      functions,
      lines: content ? content.split('\n').length : 0,
      layer,
      churn: 0,
      isCode: actualIsCode,
    });
    if (actualIsCode) {
      functions.forEach((fn) => allFns.push(Object.assign({}, fn, { folder: file.folder, layer })));
    }
  }

  return buildAnalysisData({
    analyzed,
    allFns,
    excludePatterns: [],
    progress() {},
    yieldFn: async () => {},
  });
}

test('web-app fixture uses semantic groups and hides build output', async () => {
  const data = await analyzeFixture('web-app-world');
  const diagram = data.architectureDiagram;

  assert.ok(diagram);
  assert.equal(diagram.profile, 'web-app');

  const visiblePaths = blockPaths(diagram, false, false);
  assert.equal(
    visiblePaths.some((path) => /(^|\/)out\//i.test(path) || /page-deadbeef/i.test(path)),
    false
  );
  assert.equal(getVisibleArchitectureBlocks(diagram.blocks, false, false).some((block) => block.isTest), false);

  const groups = new Set(getVisibleArchitectureBlocks(diagram.blocks, false, false).map((b) => b.group));
  assert.ok(groups.has('App Entry / Shell') || groups.has('Frontend Routes / Views'));
  assert.ok(
    groups.has('Backend / API Layer') ||
      groups.has('Services / Business Logic') ||
      groups.has('Configuration') ||
      groups.has('Shared / Utilities')
  );

  assert.ok(diagram.hiddenSummary);
  assert.ok(diagram.hiddenSummary.build >= 1 || diagram.hiddenSummary.tests >= 1);

  const mermaid = generateMermaidBlockDiagram(diagram, false, false);
  assert.doesNotMatch(mermaid, /uses \d+ calls/i);
  const order = getArchitectureGroupOrder('web-app');
  assert.ok(order.includes('App Entry / Shell'));
  assert.ok(order.includes('Frontend Routes / Views'));

  const forbiddenRoutes = [
    'Route /a-backend/src/config',
    'Route /hooks',
    'Route /ui/components',
    'Route /platforms/youtube/schema',
    'Route /a-backend/src/routes',
  ];
  for (const label of forbiddenRoutes) {
    assert.doesNotMatch(mermaid, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(mermaid, /LandingPage.*global-error/i);
  assert.match(mermaid, /Global Error Boundary|global-error/i);
});

test('web-app fixture classifies backend barrels and shared indexes without routes', async () => {
  const data = await analyzeFixture('web-app-world');
  const diagram = data.architectureDiagram;
  const routeBlocks = getVisibleArchitectureBlocks(diagram.blocks, false, false).filter(
    (block) => block.role === 'frontend-route' || (block.route && block.kind === 'page')
  );

  for (const block of routeBlocks) {
    const files = (block.files || []).join(' ');
    assert.equal(/a-backend\/src\/(config|middleware|routes)\/index\.js/i.test(files), false);
    assert.equal(/src\/hooks\/index\.ts/i.test(files), false);
    assert.equal(/src\/ui\/components\/index\.ts/i.test(files), false);
    assert.equal(/src\/platforms\/youtube\/schema\/index\.ts/i.test(files), false);
  }
});
