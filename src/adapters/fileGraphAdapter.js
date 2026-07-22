// File-layer GraphIR adapter — MOO-70 Commit 5.
//
// Converts server/lib/pyanSymbolJoin.js's joined output into a file-layer
// GraphIR, mirroring src/adapters/repositoryGraphAdapter.js's pattern
// exactly: a pure function producing a bare GraphIR via makeGraphIR, not
// an AdapterResult — wrapping in buildAdapterResult (partial/diagnostics/
// cache) is the service endpoint's job (MOO-70 Commit 7), same as
// server/routes/graph-repository.js wraps adaptRepositoryAnalysis's
// output rather than the adapter doing it itself.
import { makeCoordinate } from '../graph-ir/sourceCoordinate.js';
import { makeGraphIR } from '../graph-ir/graphIR.js';

function repositoryIdentity(context) {
  return { host: 'github.com', owner: context.sourceOwner, name: context.sourceRepo };
}

function requestCoordinate(context, path) {
  return makeCoordinate({
    repository: repositoryIdentity(context),
    revision: context.resolvedSha,
    path,
    symbolKind: 'module',
  });
}

// Full authoritative identity/range from the tree-sitter symbol index,
// regardless of whether pyan3 also confirmed this node (matched) or not
// (symbolOnly) — never derived from pyan3's own tooltip line info.
function symbolCoordinate(context, symbol) {
  const range =
    symbol.symbolKind === 'module'
      ? null
      : {
          startLine: symbol.startLine,
          startColumn: symbol.startColumn,
          endLine: symbol.endLine,
          endColumn: symbol.endColumn,
        };
  return makeCoordinate({
    repository: repositoryIdentity(context),
    revision: context.resolvedSha,
    path: symbol.path,
    symbolPath: symbol.symbolPath,
    symbolKind: symbol.symbolKind,
    range,
    ambiguous: false,
  });
}

/**
 * Adapt a MOO-70 Commit 4 join result into a file-layer GraphIR.
 * @param {object} input
 * @param {import('../graph-ir/githubContext.js').AnalysisContext} input.context
 * @param {string} input.requestPath - the file or package path this graph is "of"
 * @param {ReturnType<typeof import('../../server/lib/pyanSymbolJoin.js').joinPyanToSymbols>} input.joined
 * @param {{name: string, version: string}} input.analyzer
 * @returns {import('../graph-ir/graphIR.js').GraphIR}
 */
export function adaptFileAnalysis({ context, requestPath, joined, analyzer }) {
  // Node id: reuse pyan3's mangled id when a pyan3 node exists (already
  // unique within one DOT graph). For a symbolOnly entry, synthesize an
  // id from path+qualifiedName rather than qualifiedName alone -- two
  // symbol-index entries can share a qualifiedName in the (rare,
  // defensively-detected) ambiguous case, and both would then be left
  // unclaimed as symbolOnly duplicates; qualifiedName alone would collide.
  function nodeId(entry) {
    return entry.pyanNode ? entry.pyanNode.id : `symbol:${entry.symbol.path}#${entry.symbol.qualifiedName}`;
  }

  // Groups: one per class-kind symbol, nested to match the *resolved*
  // tree-sitter scope chain (symbol.parentScope) -- not pyan3's own DOT
  // subgraph clusters, consistent with this ticket's governing "don't
  // rely on presentation labels as source metadata" decision.
  const groupIdByQualifiedName = new Map();
  for (const entry of joined.resolved) {
    if (entry.symbol && entry.symbol.symbolKind === 'class') {
      groupIdByQualifiedName.set(entry.symbol.qualifiedName, `grp:${entry.symbol.qualifiedName}`);
    }
  }
  const groups = [];
  for (const entry of joined.resolved) {
    if (entry.symbol && entry.symbol.symbolKind === 'class') {
      groups.push({
        id: groupIdByQualifiedName.get(entry.symbol.qualifiedName),
        layer: 'file',
        label: entry.symbol.shortName,
        parentGroupId: groupIdByQualifiedName.get(entry.symbol.parentScope) || null,
      });
    }
  }

  const warnings = [...joined.stats.warnings];
  const nodes = joined.resolved.map((entry) => {
    const { pyanNode, matchState, symbol } = entry;
    const id = nodeId(entry);
    const groupId = symbol ? groupIdByQualifiedName.get(symbol.parentScope) || null : null;

    if (matchState === 'matched' || matchState === 'symbolOnly') {
      const node = {
        id,
        layer: 'file',
        kind: symbol.symbolKind,
        label: symbol.shortName,
        coordinate: symbolCoordinate(context, symbol),
        groupId,
        hints: { shape: symbol.symbolKind === 'class' ? 'diamond' : 'rect', colorRole: 'default' },
      };
      if (matchState === 'symbolOnly') {
        // Distinguishes "we know exactly what this is, we just don't
        // know what it calls" (symbolOnly) from "we're not sure what
        // this even is" (unresolved/ambiguous, below) -- the ticket's own
        // Commit 9 review question.
        node.metadata = { noRelationshipData: true };
      }
      return node;
    }

    // unresolved / ambiguous: no coordinate is fabricated from pyan3's
    // own tooltip line info -- never invent an exact source range from
    // label text alone.
    warnings.push(`${matchState} pyan3 node: ${pyanNode.qualifiedName || pyanNode.id}`);
    return {
      id,
      layer: 'file',
      kind: pyanNode.kind && pyanNode.kind !== 'unknown' ? pyanNode.kind : 'unknown',
      label: pyanNode.label || pyanNode.qualifiedName || pyanNode.id,
      coordinate: null,
      groupId: null,
      hints: { shape: 'rect', colorRole: 'warning' },
    };
  });

  let edgeSeq = 0;
  const edges = joined.edges.map((edge) => ({
    id: `edge:${edgeSeq++}`,
    layer: 'file',
    kind: edge.kind,
    source: edge.source,
    target: edge.target,
  }));

  const { matchedCount, unresolvedCount, ambiguousCount, symbolOnlyCount } = joined.stats;
  const total = matchedCount + unresolvedCount + ambiguousCount + symbolOnlyCount;
  const confidence = total === 0 ? 1 : matchedCount / total;

  return makeGraphIR({
    layer: 'file',
    context,
    rootCoordinate: requestCoordinate(context, requestPath),
    analyzer,
    confidence,
    groups,
    nodes,
    edges,
    warnings,
    // Cross-boundary unresolved calls (imports/calls to code outside the
    // analyzed file(s)) are NOT counted here -- neither analyzer gives any
    // signal one occurred (see MOO-70 Commit 4's pyanSymbolJoin.js), so
    // there is nothing to report. That is a documented static-analysis
    // limitation for MOO-70 Commit 9, not a per-graph warning.
    metadata: { matchedCount, unresolvedCount, ambiguousCount, symbolOnlyCount },
  });
}
