// Canonical Python symbol index — MOO-70 Commit 1.
//
// Server-side, Node-native tree-sitter parsing of one Python file's source
// into a flat list of symbol entries (module/class/function/method). Entries
// use the exact field names of the GraphIR SourceCoordinate/SourceRange
// contract (src/graph-ir/sourceCoordinate.js: startLine/startColumn/
// endLine/endColumn, symbolPath, symbolKind) so the pyan3 join (Commit 4)
// and GraphIR conversion (Commit 5) need no reshaping layer.
//
// Uses web-tree-sitter (WASM) rather than the native `tree-sitter` binding
// so no node-gyp/prebuilt-binary step is needed at deploy time. The grammar
// file is read from the installed tree-sitter-wasms package on disk — this
// is deliberately not the CDN-fetching client-side parser in
// src/analyzer.js, which depends on browser-only globals (TreeSitter,
// fetch) and cannot run in Node (see github-analyzer-bridge.js, which has
// to stub those globals just to import analyzer.js safely).

import { createRequire } from 'node:module';
import { normalizePath } from '../../src/graph-ir/sourceCoordinate.js';
import { getWebTreeSitterParserClass } from './webTreeSitterRuntime.js';

const require = createRequire(import.meta.url);

let parserPromise = null;

function loadParser() {
  // MOO-72 Commit 1A review (round 2): the `Parser` class and its one-time
  // `.init()` call now come from webTreeSitterRuntime.js's shared
  // singleton, not a private `require('web-tree-sitter')` here -- see that
  // module's doc comment for why a second, independent require of the same
  // package in the same process (once node-tree-sitter-shim.js also needs
  // it) would otherwise break this exact function.
  return getWebTreeSitterParserClass()
    .then((Parser) => Parser.Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm')).then((Lang) => {
      const parser = new Parser();
      parser.setLanguage(Lang);
      return parser;
    }));
}

function getParser() {
  if (!parserPromise) parserPromise = loadParser();
  return parserPromise;
}

const DEF_TYPES = new Set(['function_definition', 'class_definition']);

/**
 * Derive a dotted module identity from a repo-relative file path.
 * `pkg/mod.py` -> `pkg.mod`; `pkg/__init__.py` -> `pkg` (never an empty
 * string, at any nesting depth: `pkg/sub/__init__.py` -> `pkg.sub`).
 * A root-level `__init__.py` with no parent directory falls back to
 * `__init__` itself, since there is no package name to derive from.
 * @param {string} path
 * @returns {string}
 */
export function moduleIdFromPath(path) {
  const normalized = String(path).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  const last = segments[segments.length - 1];
  if (last === '__init__.py') {
    segments.pop();
    if (segments.length === 0) return '__init__';
  } else {
    segments[segments.length - 1] = last.replace(/\.py$/, '');
  }
  return segments.join('.');
}

// MOO-71 Commit 10 (review follow-up): byte ranges of every ERROR/MISSING
// node in the tree, so a caller can ask "is there a parse error inside this
// specific byte range" instead of only "does this file have a parse error
// anywhere" -- tree.rootNode.hasError() is file-wide, so an unrelated syntax
// error elsewhere in the file would otherwise make every function in the
// file look unparseable, masking a real bug in a function that itself parses
// fine. Only walked when hasError() is already true, so a clean file (the
// common case) pays nothing extra.
function collectErrorRanges(node, out) {
  // web-tree-sitter's isMissing/hasError are methods, not properties -- a
  // missing-call reference is always truthy and would silently treat every
  // node as an error range.
  if (node.type === 'ERROR' || node.isMissing()) {
    out.push({ startIndex: node.startIndex, endIndex: node.endIndex });
  }
  for (let i = 0; i < node.childCount; i++) {
    collectErrorRanges(node.child(i), out);
  }
  return out;
}

function rangeOf(node) {
  return {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
  };
}

// function_definition's first child is the literal `async` token when the
// def is declared async; absent otherwise.
function isAsyncDef(node) {
  const first = node.child(0);
  return !!first && first.type === 'async';
}

function collectDecorators(decoratedNode) {
  const decorators = [];
  for (let i = 0; i < decoratedNode.namedChildCount; i++) {
    const child = decoratedNode.namedChild(i);
    if (child.type === 'decorator') decorators.push(child.text);
  }
  return decorators;
}

function qualifiedNameFor(moduleId, scopeChain) {
  return [moduleId, ...scopeChain].filter(Boolean).join('.');
}

/**
 * Recursively walk a class/function/module body, appending one entry per
 * class/function/method definition found. `enclosingKind` is the kind of
 * the scope `node`'s definitions belong to ('module'|'class'|'function') —
 * a def directly inside a 'class' body is a 'method'; a def inside a
 * 'function' (or 'method') body is a nested 'function', never a 'method'.
 *
 * Recurses into every child, not just direct children of a def's own body
 * block: only `function_definition`/`class_definition` (Python's actual
 * scope-introducing constructs) start a new scope. Every other construct —
 * `if`/`elif`/`else`, `try`/`except`/`finally`, `for`/`while` (+ their
 * `else`), `with`, `match`/`case` — is scope-transparent in real Python, so
 * a `def` nested inside one of those must still be indexed at its
 * enclosing scope, not skipped. A prior version only checked direct
 * children of a body block and silently missed every conditionally/
 * compound-statement-wrapped definition (found via code review against a
 * real fixture using `if PY2: def x / else: def x` — exactly the pattern
 * this ticket's own pyanSymbolJoin fix was written to handle, but which
 * the indexer itself never actually surfaced as a symbol-index entry
 * before this fix).
 */
function walkNode(node, ctx, scopeChain, enclosingKind, entries) {
  if (!node) return;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    let defNode = child;
    let decorators = [];
    if (child.type === 'decorated_definition') {
      decorators = collectDecorators(child);
      defNode = child.namedChildren[child.namedChildren.length - 1];
    }

    if (defNode && DEF_TYPES.has(defNode.type)) {
      const nameNode = defNode.childForFieldName('name');
      const shortName = nameNode ? nameNode.text : '<anonymous>';
      const newScopeChain = [...scopeChain, shortName];
      const isClass = defNode.type === 'class_definition';
      const symbolKind = isClass ? 'class' : enclosingKind === 'class' ? 'method' : 'function';

      entries.push({
        path: ctx.path,
        moduleId: ctx.moduleId,
        qualifiedName: qualifiedNameFor(ctx.moduleId, newScopeChain),
        shortName,
        symbolKind,
        symbolPath: newScopeChain,
        parentScope: scopeChain.length === 0 ? ctx.moduleId : qualifiedNameFor(ctx.moduleId, scopeChain),
        ...rangeOf(defNode),
        decorators,
        isAsync: isAsyncDef(defNode),
      });

      const childBody = defNode.childForFieldName('body');
      walkNode(childBody, ctx, newScopeChain, isClass ? 'class' : 'function', entries);
      continue;
    }

    // Not a definition itself -- descend with the *same* scope in case a
    // definition is nested inside a compound statement (if/try/for/while/
    // with/match) at this same lexical scope.
    walkNode(child, ctx, scopeChain, enclosingKind, entries);
  }
}

/**
 * Parse one Python file's source and return its canonical symbol index.
 * @param {object} input
 * @param {string} input.path - repo-root-relative file path
 * @param {string} input.content - the file's full source text
 * @returns {Promise<{path: string, moduleId: string, parseErrors: boolean, errorRanges: {startIndex: number, endIndex: number}[], entries: object[]}>}
 */
export async function indexPythonSymbols({ path, content }) {
  const parser = await getParser();
  const tree = parser.parse(content);
  const parseErrors = tree.rootNode.hasError();
  // Only walked on the error path -- see collectErrorRanges' own comment.
  const errorRanges = parseErrors ? collectErrorRanges(tree.rootNode, []) : [];
  // Normalized once, at the source, so every entry's `path` is consistently
  // POSIX-form regardless of the caller's own path-separator convention
  // (e.g. Node's `path.join` on Windows produces backslashes) -- found via
  // PR review: pyanSymbolJoin.js's path filter compared this raw path
  // directly against pyan3's own (already-normalized) path and silently
  // never matched on Windows, since a hard filter surfaced what a
  // soft warning previously masked.
  const normalizedPath = normalizePath(path);
  const moduleId = moduleIdFromPath(normalizedPath);
  const ctx = { path: normalizedPath, moduleId };

  const entries = [
    {
      path: normalizedPath,
      moduleId,
      qualifiedName: moduleId,
      shortName: moduleId.split('.').filter(Boolean).pop() || moduleId,
      symbolKind: 'module',
      symbolPath: [],
      parentScope: null,
      startLine: null,
      startColumn: null,
      endLine: null,
      endColumn: null,
      decorators: [],
      isAsync: false,
    },
  ];

  walkNode(tree.rootNode, ctx, [], 'module', entries);

  return {
    path: normalizedPath,
    moduleId,
    parseErrors,
    errorRanges,
    entries,
  };
}
