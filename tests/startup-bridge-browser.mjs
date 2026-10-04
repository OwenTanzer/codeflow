// Actual dev/built entry + classic-worker success, fallback and disposal.
// Serve the app first. No server repository credential is needed for this gate.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:5173/';
const contract = JSON.parse(readFileSync(new URL('./fixtures/startup-bridge-contract.json', import.meta.url)));
const browser = await chromium.launch();
const errors = [], results = [], failures = [];
try {
  for (const mode of ['worker', 'worker-error', 'unavailable', 'source-failure']) {
    const page = await browser.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/\[BABEL\] Note: The code generator has deoptimised/.test(m.text())) errors.push(m.text()); });
    // Health is unrelated to local analysis; explicitly mark this fixture.
    await page.route('**/healthz', r => r.fulfill({ json: { status: 'ok', testFixture: true } }));
    await page.addInitScript(mode => {
      const probe = window.__bridgeProbe = { assignments: [], constructed: 0, terminated: 0, revoked: 0, done: 0, workerErrors: [], sourceFetches: [] };
      const assign = Object.assign;
      Object.assign = function(target, ...sources) {
        if (target === window && sources.some(source => source && 'runAnalysisData' in source)) probe.assignments.push(sources);
        return assign(target, ...sources);
      };
      const NativeWorker = window.Worker;
      window.Worker = mode === 'unavailable' ? undefined : class extends NativeWorker {
        constructor(...args) {
          super(...args); probe.constructed++;
          this.addEventListener('message', event => { if (event.data?.type === 'done') probe.done++; if(event.data?.type === 'error') probe.workerErrors.push(event.data.message); });
          this.addEventListener('error', event => probe.workerErrors.push(event.message));
        }
        postMessage(...args) {
          if (mode === 'worker-error') queueMicrotask(() => this.onerror({ message: 'Controlled worker failure' }));
          else super.postMessage(...args);
        }
        terminate() { probe.terminated++; return super.terminate(); }
      };
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = url => { probe.revoked++; return revoke(url); };
      const fetchOriginal = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (init?.cache === 'no-store') {
          probe.sourceFetches.push(String(input));
          if (mode === 'source-failure') return Promise.resolve(new Response('// deliberately missing worker source markers'));
        }
        return fetchOriginal(input, init);
      };
    }, mode);
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: 'Repository URL', exact: true }).first().waitFor();
    const result = await page.evaluate(async ({ contract, mode }) => {
      const p = window.__bridgeProbe;
      if (p.assignments.length !== 1) throw Error('Expected exactly one startup registration');
      const [analyzer, explicit, ...extra] = p.assignments[0];
      const sameKeys = (a,b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
      if (extra.length || !sameKeys(Object.keys(analyzer),contract.analyzerExports) ||
          !sameKeys(Object.keys(explicit),Object.values(contract.explicitModules).flat())) throw Error('Bridge surface changed');
      for (const source of [analyzer, explicit]) for (const name of Object.keys(source)) {
        if (window[name] !== (name in explicit ? explicit[name] : analyzer[name])) throw Error('Identity mismatch: '+name);
      }
      for (const name of ['fetchCapabilities','fetchBlame','fetchFileContentFromServer']) if (typeof window[name] !== 'function') throw Error(name+' absent');
      const content = 'export function foo() { return 1; }\n';
      const functions = Parser.extract(content, 'a.js');
      const options = { analyzed: [{ path:'a.js', name:'a.js', folder:'root', content, functions, lines:2, layer:'app', churn:0, isCode:true }],
        allFns: functions.map(fn => ({...fn,folder:'root',layer:'app'})), excludePatterns:[], progress:()=>{}, yieldFn:()=>Promise.resolve() };
      const fresh = () => ({...options, analyzed:structuredClone(options.analyzed), allFns:structuredClone(options.allFns)});
      const expected = await buildAnalysisData(fresh());
      const actual = await runAnalysisData(fresh());
      return {expected, actual, mode, keys:Object.keys({...analyzer,...explicit}).length, files:actual.stats.files, functions:actual.stats.functions,
        constructed:p.constructed, terminated:p.terminated, revoked:p.revoked, done:p.done, workerErrors:p.workerErrors, sourceFetches:p.sourceFetches};
    }, {contract, mode});
    assert.deepEqual(result.actual, result.expected, mode + ': worker/fallback parity');
    delete result.actual; delete result.expected;
    assert.equal(result.keys, 55);
    assert.equal(result.files, 1);
    assert.equal(result.functions, 1);
    const constructs = ['worker','worker-error'].includes(mode) ? 1 : 0;
    assert.equal(result.constructed, constructs);
    assert.equal(result.terminated, constructs);
    assert.equal(result.revoked, constructs);
    console.log(JSON.stringify(result));
    if (result.done !== (mode === 'worker' ? 1 : 0)) failures.push(mode + ': success must come from the worker, not fallback');
    assert.equal(result.sourceFetches.length, mode === 'unavailable' ? 0 : 1);
    results.push(result);
    await page.close();
  }
  console.log(JSON.stringify({url,browser:browser.version(),realDevice:false,healthEndpoint:'controlled fixture',results,errors,failures},null,2));
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
} finally { await browser.close(); }
