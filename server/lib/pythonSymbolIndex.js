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

const require = createRequire(import.meta.url);

let parserPromise = null;

function loadParser() {
  const Parser = require('web-tree-sitter');
  return Parser.init()
    .then(() => Parser.Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm')))
    .then((Lang) => {
      const parser = new Parser();
      parser.setLanguage(Lang);
      return parser;
    });
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
 * the scope `bodyNode` belongs to ('module'|'class'|'function') — a def
 * directly inside a 'class' body is a 'method'; a def inside a 'function'
 * (or 'method') body is a nested 'function', never a 'method'.
 */
function walkBody(bodyNode, ctx, scopeChain, enclosingKind, entries) {
  if (!bodyNode) return;
  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const child = bodyNode.namedChild(i);
    let defNode = child;
    let decorators = [];
    if (child.type === 'decorated_definition') {
      decorators = collectDecorators(child);
      defNode = child.namedChildren[child.namedChildren.length - 1];
    }
    if (!defNode || !DEF_TYPES.has(defNode.type)) continue;

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
    walkBody(childBody, ctx, newScopeChain, isClass ? 'class' : 'function', entries);
  }
}

/**
 * Parse one Python file's source and return its canonical symbol index.
 * @param {object} input
 * @param {string} input.path - repo-root-relative file path
 * @param {string} input.content - the file's full source text
 * @returns {Promise<{path: string, moduleId: string, parseErrors: boolean, entries: object[]}>}
 */
export async function indexPythonSymbols({ path, content }) {
  const parser = await getParser();
  const tree = parser.parse(content);
  const moduleId = moduleIdFromPath(path);
  const ctx = { path, moduleId };

  const entries = [
    {
      path,
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

  walkBody(tree.rootNode, ctx, [], 'module', entries);

  return {
    path,
    moduleId,
    parseErrors: tree.rootNode.hasError(),
    entries,
  };
}
