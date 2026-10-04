// Exercise the real bundler: a constructed worker alone cannot prove that
// minified output still contains its executable source slice.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { build } from 'vite';
import { preserveAnalyzerSource } from '../scripts/vite-analyzer-source.mjs';

test('production build imports one unchanged, hashed analyzer with executable worker core', async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [preserveAnalyzerSource()],
    build: { write: false, rollupOptions: { input: fileURLToPath(new URL('../index.html', import.meta.url)) } },
  });
  const source = readFileSync(new URL('../src/analyzer.js', import.meta.url), 'utf8');
  const analyzers = result.output.filter(output => /^assets\/analyzer-[a-f0-9]{16}\.js$/.test(output.fileName));
  assert.equal(analyzers.length, 1);
  const asset = analyzers[0];
  assert.equal(Buffer.from(asset.source).toString('utf8'), source);
  const entry = result.output.find(output => output.type === 'chunk' && output.isEntry);
  assert.ok(entry.imports.some(path => path.endsWith(asset.fileName.split('/').at(-1))), 'entry must actually load the emitted analyzer');
  assert.ok(!entry.moduleIds.some(id => id.endsWith('/src/analyzer.js')), 'no bundled second copy');
  const start = source.indexOf('// ===== CODEFLOW_CORE_START =====');
  const end = source.indexOf('// ===== CODEFLOW_CORE_END =====', start);
  assert.ok(start >= 0 && end > start);
  const workerCore = new vm.Script(source.slice(start, end) + '\n typeof buildAnalysisData');
  assert.equal(workerCore.runInNewContext(), 'function');
});
