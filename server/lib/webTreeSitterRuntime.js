// Shared web-tree-sitter runtime singleton — MOO-72 Commit 1A review
// (round 2, Blocker B).
//
// `web-tree-sitter`'s `Parser.init()` has a real, load-bearing side effect
// in Node: the emscripten-generated module reassigns `module.exports =
// Module` (the low-level runtime object, not the `Parser` class) as part of
// its init body, the first time `.init()` is ever called anywhere in the
// process. Node's CJS module cache is keyed by resolved file path, shared
// across every `createRequire()` context regardless of which file created
// it -- so once ANY code calls `.init()`, every *subsequent, independent*
// `require('web-tree-sitter')` call (even from a completely different
// module) gets back that mutated low-level object instead of the `Parser`
// class, and `Parser.init is not a function` follows.
//
// This module exists so `.init()` is called exactly once, by exactly one
// piece of code, with the resulting `Parser` class reference shared by
// every consumer (server/lib/pythonSymbolIndex.js and
// server/lib/node-tree-sitter-shim.js) instead of each independently
// `require()`-ing and `.init()`-ing the package.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let parserClassPromise = null;

/** @returns {Promise<any>} the real web-tree-sitter `Parser` class, initialized exactly once. */
export function getWebTreeSitterParserClass() {
  if (!parserClassPromise) {
    const RealParser = require('web-tree-sitter');
    parserClassPromise = RealParser.init().then(() => RealParser);
  }
  return parserClassPromise;
}
