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
// (already dotted, unambiguous) is the join's *first* filter, not its only
// one — see the path/kind/scope filters below.
//
// PR review finding: an earlier version matched purely on qualifiedName
// and applied the same-scope-redefinition tie-break (see below)
// unconditionally, meaning a pyan3 node whose reported path or kind
// genuinely disagreed with the one candidate sharing its qualifiedName
// still got `matchState: 'matched'` and that candidate's exact
// coordinate — merely logging a warning. That defeats the dual-analyzer
// design's whole point (never attach a high-confidence identity pyan3
// didn't actually corroborate). Fixed: path and kind/scope compatibility
// are now hard filters applied *before* any tie-break; a mismatch now
// correctly falls through to `unresolved` rather than `matched`.
import { relative } from 'node:path';
import { normalizePath } from '../../src/graph-ir/sourceCoordinate.js';

// pyan3's tooltip reports "method" for a class method, but "staticmethod"/
// "classmethod" for those specific decorator forms (confirmed against
// real output — psf/requests' models.py) — all three still name our
// canonical 'method' symbolKind, not a mismatch. 'unknown' means the
// tooltip's kind suffix didn't parse (see dotGraph.js's parseTooltip) and
// is treated as a wildcard rather than a forced mismatch, since we have
// no real signal either way.
const KIND_COMPATIBILITY = {
  module: new Set(['module']),
  class: new Set(['class']),
  function: new Set(['function']),
  method: new Set(['method', 'staticmethod', 'classmethod']),
};

function isKindCompatible(symbolKind, pyanKind) {
  if (!pyanKind || pyanKind === 'unknown') return true;
  const compatible = KIND_COMPATIBILITY[symbolKind];
  return compatible ? compatible.has(pyanKind) : symbolKind === pyanKind;
}

// Real Python routinely defines multiple same-name symbols in one scope
// that collapse to a single runtime name: typing.overload stubs followed
// by the real implementation, @property getter/setter/deleter triples, or
// conditional `if PY2: def x / else: def x`. pyan3 itself only ever
// reports one node for these (matching Python's actual
// last-definition-wins name-shadowing semantics). `candidates` here have
// already passed the path/kind/scope filters, so they are known-compatible
// redefinitions of literally the same symbol, not unrelated matches —
// tie-breaking among them (rather than calling every such case ambiguous)
// is safe. Prefers the candidate whose line pyan3 itself reported (the
// strongest available signal for which specific definition pyan3
// resolved to); falls back to the textually-last definition when pyan3
// didn't report a line or its line doesn't exactly match any candidate.
// Confirmed necessary against a real fixture (psf/requests' models.py,
// which uses exactly this typing.overload pattern for
// _encode_params/iter_content/iter_lines). Only a genuine tie in source
// position (which shouldn't occur for distinct definitions) is still
// reported ambiguous.
function selectAmongCandidates(candidates, pyanNode) {
  if (candidates.length === 1) return candidates;
  if (pyanNode.line != null) {
    const lineMatches = candidates.filter((c) => c.startLine === pyanNode.line);
    if (lineMatches.length === 1) return lineMatches;
    if (lineMatches.length > 1) candidates = lineMatches;
  }
  const maxLine = Math.max(...candidates.map((c) => (c.startLine == null ? -Infinity : c.startLine)));
  return candidates.filter((c) => (c.startLine == null ? -Infinity : c.startLine) === maxLine);
}

/**
 * @param {object} input
 * @param {{id: string, label: string|null, qualifiedName: string|null, path: string|null, line: number|null, kind: string, parentScope: string|null}[]} input.pyanNodes
 * @param {{source: string, target: string, kind: string}[]} input.pyanEdges
 * @param {object[]} input.symbolEntries - flattened concatenation of every staged file's indexPythonSymbols(...).entries for this request
 * @param {string} [input.workspaceDir] - the request workspace root files were staged under (server/lib/workspace.js), used to recover pyan3's absolute paths back to repo-relative. MOO-72 Commit 4: omit (or pass '') when pyanNodes' `path` fields are already repo-relative -- the shared in-flight pyan3 registry converts them before any caller sees them, since no single caller's own workspace exists once the shared workspace is torn down.
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
    const normalizedPath = pyanNode.path
      ? normalizePath(workspaceDir ? relative(workspaceDir, pyanNode.path) : pyanNode.path)
      : null;
    const nameCandidates = pyanNode.qualifiedName ? byQualifiedName.get(pyanNode.qualifiedName) : undefined;

    if (!nameCandidates || nameCandidates.length === 0) {
      unresolvedCount++;
      resolved.push({ pyanNode, matchState: 'unresolved', symbol: null });
      continue;
    }

    // Hard filters — a candidate that disagrees with what pyan3 itself
    // reported is not a match, full stop; it must never surface as
    // `matched` with a mismatch merely noted in a warning.
    let candidates = nameCandidates;
    if (normalizedPath !== null) {
      candidates = candidates.filter((c) => c.path === normalizedPath);
    }
    if (pyanNode.kind) {
      candidates = candidates.filter((c) => isKindCompatible(c.symbolKind, pyanNode.kind));
    }
    if (pyanNode.parentScope != null) {
      candidates = candidates.filter((c) => c.parentScope === pyanNode.parentScope);
    }

    if (candidates.length === 0) {
      unresolvedCount++;
      resolved.push({ pyanNode, matchState: 'unresolved', symbol: null });
      continue;
    }

    const winners = selectAmongCandidates(candidates, pyanNode);
    if (winners.length > 1) {
      ambiguousCount++;
      resolved.push({ pyanNode, matchState: 'ambiguous', symbol: null });
      continue;
    }

    const symbol = winners[0];
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
