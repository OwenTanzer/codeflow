// Node-native tree-sitter shim — MOO-72 Commit 1A review (round 2, Blocker
// B): wires the real `web-tree-sitter` + `tree-sitter-wasms` runtime already
// used by server/lib/pythonSymbolIndex.js into `globalThis.TreeSitter`, so
// src/analyzer.js's `Parser` (written for the browser's CDN-loaded
// web-tree-sitter) gets a real, working tree-sitter runtime in Node instead
// of staying stubbed to `undefined`.
//
// Two real Node-incompatibilities in `Parser`'s own code, both worked
// around here rather than by changing `Parser` itself:
//
// 1. `web-tree-sitter`'s `Parser.init()` has a load-bearing side effect the
//    first time it's ever called anywhere in the process: it reassigns
//    `module.exports` to the low-level runtime object instead of the
//    `Parser` class. Since Node's module cache is shared by resolved path
//    regardless of which file's `createRequire` asked for it, calling
//    `.init()` here from an independent `require('web-tree-sitter')` would
//    silently break `pythonSymbolIndex.js`'s *own* later
//    `require('web-tree-sitter')` call (or vice versa) with
//    `Parser.init is not a function`. `webTreeSitterRuntime.js`'s shared
//    singleton exists specifically so `.init()` runs exactly once and both
//    consumers share the one captured `Parser` class reference, obtained
//    before that mutation ever happens.
// 2. `Parser.treeSitterWasmBase` (src/analyzer.js) is a CDN URL string.
//    `web-tree-sitter`'s `Language.load()` does a raw `fs.readFileSync` on
//    whatever string it's given in Node — a CDN URL fails with ENOENT.
//    Reassigning `Parser.treeSitterWasmBase` to the real local directory
//    `tree-sitter-wasms` installs into (resolved via `require.resolve`,
//    exactly as `pythonSymbolIndex.js` already does for the Python
//    grammar) fixes every grammar's path, not just Python's — every
//    grammar `Parser.treeSitterGrammars` lists is already vendored in
//    `node_modules/tree-sitter-wasms/out/`.
//
// If the real package fails to load for any reason, `globalThis.TreeSitter`
// is left `undefined` (matching the previous stub) so `Parser`'s existing
// `typeof TreeSitter==='undefined'` check and its own try/catch-to-`null`
// fallbacks apply unchanged — this only removes the always-off stub, it
// doesn't introduce a new failure mode.
import { createRequire } from 'node:module';
import path from 'node:path';
import { getWebTreeSitterParserClass } from './webTreeSitterRuntime.js';

const require = createRequire(import.meta.url);

// MOO-72 Commit 2: a loaded runtime does not prove the Python *grammar* is
// usable — the wasm file can be missing or corrupted independently of
// web-tree-sitter itself importing fine. The repository layer's cache key
// records whether Python analysis actually had tree-sitter available, so
// this has to be an active probe (a real Language.load) rather than a
// `typeof globalThis.TreeSitter` check that would report capable while
// every Python parse silently fell back to the regex heuristic.
let pythonGrammarCapable = false;

/** Whether the Python tree-sitter grammar actually loaded at startup. */
export function isPythonGrammarCapable() {
  return pythonGrammarCapable;
}

/**
 * @param {{ treeSitterWasmBase?: string }} ParserObj - src/analyzer.js's `Parser`, so its `treeSitterWasmBase` can be repointed at a real local directory.
 */
export async function installNodeTreeSitter(ParserObj) {
  let RealParser;
  try {
    RealParser = await getWebTreeSitterParserClass();
    globalThis.TreeSitter = RealParser;
    if (ParserObj) {
      ParserObj.treeSitterWasmBase = path.dirname(require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm')) + '/';
    }
  } catch {
    globalThis.TreeSitter = undefined;
    pythonGrammarCapable = false;
    return;
  }

  // Scoped separately from the runtime install above: a missing/corrupt
  // Python grammar must not disable tree-sitter for every *other* language,
  // which is what folding this into the same catch would do.
  try {
    await RealParser.Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm'));
    pythonGrammarCapable = true;
  } catch {
    pythonGrammarCapable = false;
  }
}
