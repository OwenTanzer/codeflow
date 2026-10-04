// Regression contract captured before extraction from baseline 21e48a2462.
// Execute the actual HTML module entry, not a source-location string search.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'acorn';

const root = new URL('../', import.meta.url);
const appSource = readFileSync(new URL('index.html', root), 'utf8');
const contract = JSON.parse(readFileSync(new URL('fixtures/startup-bridge-contract.json', import.meta.url)));

test('actual entry registers the complete bridge with original identities and precedence', async () => {
  const scripts = [...appSource.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)];
  const entries = scripts.filter(m => /type="module"/.test(m[1]));
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(scripts[scripts.indexOf(entry) + 1][1].trim(), 'type="text/babel"');
  assert.ok(appSource.indexOf('<div id="root"></div>') < entry.index);
  assert.doesNotMatch(entry[1], /\b(?:async|src)=/);
  const ast = parse(entry[2], { ecmaVersion: 'latest', sourceType: 'module' });
  assert.equal(ast.body.length, 1);
  assert.equal(ast.body[0].type, 'ImportDeclaration');
  assert.equal(ast.body[0].source.value, './src/browser/startupBridge.js');
  assert.equal(ast.body[0].specifiers.length, 0);

  const analyzer = await import('../src/analyzer.js');
  assert.deepEqual(Object.keys(analyzer).sort(), contract.analyzerExports);
  const explicit = {};
  for (const [path, names] of Object.entries(contract.explicitModules)) {
    const module = await import(new URL(path, root));
    for (const name of names) explicit[name] = module[name];
  }
  const expected = Object.assign({}, analyzer, explicit);
  const sentinel = {};
  const target = Object.fromEntries(Object.keys(expected).map(name => [name, sentinel]));
  target.unrelatedExistingGlobal = sentinel;
  const writes = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.window = new Proxy(target, {
    set(object, key, value) { writes.push([key, value]); object[key] = value; return true; },
  });
  try {
    await import(new URL(ast.body[0].source.value, root));
    assert.deepEqual(Object.keys(target).filter(n => n !== 'unrelatedExistingGlobal').sort(), Object.keys(expected).sort());
    for (const [name, value] of Object.entries(expected)) {
      assert.notEqual(value, undefined, name);
      assert.strictEqual(target[name], value, name + ' must retain its module identity');
    }
    // Also observes two writes if a future analyzer export overlaps an explicit helper.
    assert.deepEqual(writes.map(([name]) => name), [...Object.keys(analyzer), ...Object.keys(explicit)]);
    writes.forEach(([name, value], i) => assert.strictEqual(value, i < Object.keys(analyzer).length ? analyzer[name] : explicit[name]));
    assert.strictEqual(target.unrelatedExistingGlobal, sentinel);
    for (const name of contract.bareBridgeConsumers) assert.ok(name in target, name);
    for (const name of ['fetchCapabilities', 'fetchBlame', 'fetchFileContentFromServer']) {
      assert.equal(typeof target[name], 'function', name);
      assert.strictEqual(target[name], explicit[name]);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  }
});

test('both inline layer panels still check capabilities', () => {
  assert.equal((appSource.match(/fetchCapabilities\s*\(\s*\)/g) ?? []).length, 2);
});

test('fatal application errors are not unconditionally described as memory failures', () => {
  assert.equal(appSource.includes("The codebase may be too large for your browser's available memory."), false);
  assert.match(appSource, /An unexpected error prevented CodeFlow from continuing\./);
});
