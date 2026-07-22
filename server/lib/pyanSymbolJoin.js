// Join pyan3 nodes to canonical tree-sitter symbols — MOO-70 Commit 4.
//
// pyan3 (server/lib/pyan3Adapter.js + server/lib/dotGraph.js) reports
// relationships; the tree-sitter symbol index (server/lib/pythonSymbolIndex.js)
// reports authoritative identity and exact source ranges. This module is
// the one place those two signals are reconciled, keyed on the dotted
// qualifiedName both analyzers derive from the same --root-relative
// module id (server/lib/pyan3Adapter.js always pins --root to the
// request's workspace dir, which is exactly what makes this join key
// reliable rather than coincidental).
//
// Real-environment spike finding (see the MOO-70 Commits 4/5 plan): a
// call/import to code *outside* the analyzed file set produces no pyan3
// node or edge at all — it's invisible to both analyzers, not an
// "unresolved" node this join can detect or represent. What this join
// *can* detect are genuine join failures against data both analyzers did
// report:
//   - unresolved: a pyan3 node's qualifiedName matches zero symbol-index
//     entries.
//   - ambiguous: a pyan3 node's qualifiedName matches more than one
//     symbol-index entry (shouldn't happen with correctly-staged unique
//     file paths, but is detected rather than assumed impossible).
//   - symbolOnly: the reverse — a symbol-index entry with no
//     corresponding pyan3 node at all (e.g. pyan3 crashed on that file
//     while tree-sitter's error-tolerant parse still produced a partial
//     index for it).
//
// Deliberately does NOT fall back to reverse-mangling a pyan3 node's `__`
// id into a dotted name as a second matching strategy: that mangling is
// ambiguous for any qualified name already containing a literal double
// underscore (Python dunders — __init__, __str__), so guessing from it
// could silently produce a wrong match. qualifiedName from the tooltip
// (already dotted, unambiguous) is the only join key used.
import { relative } from 'node:path';
import { normalizePath } from '../../src/graph-ir/sourceCoordinate.js';

/**
 * @param {object} input
 * @param {{id: string, label: string|null, qualifiedName: string|null, path: string|null, line: number|null, kind: string, parentScope: string|null}[]} input.pyanNodes
 * @param {{source: string, target: string, kind: string}[]} input.pyanEdges
 * @param {object[]} input.symbolEntries - flattened concatenation of every staged file's indexPythonSymbols(...).entries for this request
 * @param {string} input.workspaceDir - the request workspace root files were staged under (server/lib/workspace.js), used to recover pyan3's absolute paths back to repo-relative
 * @returns {{resolved: object[], edges: object[], stats: {matchedCount: number, unresolvedCount: number, ambiguousCount: number, symbolOnlyCount: number, warnings: string[]}}}
 */
export function joinPyanToSymbols({ pyanNodes, pyanEdges, symbolEntries, workspaceDir }) {
  const byQualifiedName = new Map();
  for (const symbol of symbolEntries) {
    const list = byQualifiedName.get(symbol.qualifiedName);
    if (list) list.push(symbol);
    else byQualifiedName.set(symbol.qualifiedName, [symbol]);
  }

  const warnings = [];
  const claimed = new Set();
  const resolved = [];
  let matchedCount = 0;
  let unresolvedCount = 0;
  let ambiguousCount = 0;

  for (const pyanNode of pyanNodes) {
    const normalizedPath =
      pyanNode.path && workspaceDir ? normalizePath(relative(workspaceDir, pyanNode.path)) : null;
    const candidates = pyanNode.qualifiedName ? byQualifiedName.get(pyanNode.qualifiedName) : undefined;

    if (!candidates || candidates.length === 0) {
      unresolvedCount++;
      resolved.push({ pyanNode, matchState: 'unresolved', symbol: null });
      continue;
    }

    // Real Python routinely defines multiple same-name symbols in one
    // scope that collapse to a single runtime name: typing.overload
    // stubs followed by the real implementation, @property
    // getter/setter/deleter triples, or conditional `if PY2: def x /
    // else: def x`. pyan3 itself only ever reports one node for these
    // (matching Python's actual last-definition-wins name-shadowing
    // semantics), so tie-break the same way rather than calling every
    // such case ambiguous -- confirmed necessary against a real fixture
    // (psf/requests' models.py, which uses exactly this typing.overload
    // pattern for _encode_params/iter_content/iter_lines). Only a
    // genuine tie in source position (which shouldn't occur for
    // distinct definitions) is still reported ambiguous.
    const maxLine = Math.max(...candidates.map((c) => (c.startLine == null ? -Infinity : c.startLine)));
    const winners = candidates.filter((c) => (c.startLine == null ? -Infinity : c.startLine) === maxLine);
    if (winners.length > 1) {
      ambiguousCount++;
      resolved.push({ pyanNode, matchState: 'ambiguous', symbol: null });
      continue;
    }

    const symbol = winners[0];
    if (normalizedPath !== null && symbol.path !== normalizedPath) {
      warnings.push(
        `path mismatch for ${pyanNode.qualifiedName}: pyan3 reported "${normalizedPath}", symbol index has "${symbol.path}"`
      );
    }
    if (pyanNode.kind !== 'unknown' && symbol.symbolKind !== pyanNode.kind) {
      warnings.push(
        `kind mismatch for ${pyanNode.qualifiedName}: pyan3 reported "${pyanNode.kind}", symbol index has "${symbol.symbolKind}"`
      );
    }
    matchedCount++;
    claimed.add(symbol.qualifiedName);
    resolved.push({ pyanNode, matchState: 'matched', symbol });
  }

  let symbolOnlyCount = 0;
  for (const symbol of symbolEntries) {
    if (!claimed.has(symbol.qualifiedName)) {
      symbolOnlyCount++;
      resolved.push({ pyanNode: null, matchState: 'symbolOnly', symbol });
    }
  }

  return {
    resolved,
    edges: pyanEdges,
    stats: { matchedCount, unresolvedCount, ambiguousCount, symbolOnlyCount, warnings },
  };
}
