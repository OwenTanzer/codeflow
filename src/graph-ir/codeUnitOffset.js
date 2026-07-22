// MOO-71 Commit 5/6: converts between a tree-sitter row/column position
// (as produced by server/lib/pythonSymbolIndex.js's startLine/
// startColumn/endLine/endColumn) and a flat index -- the unit
// @codevisualizer/core's analyzePythonFunction/FlowchartIR use as
// startByte/endByte and FlowchartNode.location/LocationMapEntry.
//
// Relocated here from server/lib/byteOffset.js in Commit 6: this logic
// has zero Node.js-specific dependency (plain JS string math), and
// Commit 6's src/adapters/functionGraphAdapter.js -- meant to stay
// runtime-neutral, mirroring fileGraphAdapter.js -- needs the reverse
// direction too. Keeping both directions in one runtime-neutral file
// avoids either duplicating this logic or having a runtime-neutral
// adapter import a Node-specific server lib.
//
// Real, verified finding (not the initially-assumed one): despite the
// general claim that "tree-sitter uses UTF-8 byte offsets" (true of the
// native/C tree-sitter library), web-tree-sitter's JS binding -- used by
// BOTH pythonSymbolIndex.js and @codevisualizer/core, so this matters --
// reports row/column and node.startIndex/endIndex in **UTF-16 code
// units** (i.e. plain JS string .length semantics), not raw UTF-8 byte
// counts. Confirmed by cross-parsing a real fixture containing
// multi-byte UTF-8 characters (accented Latin, CJK, and an astral-plane
// emoji): a Buffer.byteLength-based conversion drifted by exactly the
// UTF-8-byte-vs-UTF-16-length difference of the unicode line, while a
// plain-.length-based conversion matched @codevisualizer/core's own
// independently-parsed startIndex/endIndex exactly.
//
// Named accordingly (not lineColumnToByteOffset/byteOffsetToLineColumn,
// as an earlier draft had it) -- "byte" in a name here would actively
// mislead a future caller into reaching for Buffer.byteLength, which is
// exactly the bug this file's own history already produced once. Do not
// "fix" these to use Buffer.byteLength; that would reintroduce it. See
// tests/server-graph-function.test.mjs for the committed regression
// test.

/**
 * @param {string} source
 * @param {number} line 1-based
 * @param {number} column 0-based, UTF-16 code unit offset within the line
 * @returns {number} flat UTF-16 code unit offset from the start of source
 */
export function lineColumnToCodeUnitOffset(source, line, column) {
  const lines = source.split('\n');
  let offset = 0;
  for (let i = 0; i < line - 1; i++) {
    offset += lines[i].length + 1; // +1 for the '\n' separator
  }
  offset += column;
  return offset;
}

/**
 * The reverse of lineColumnToCodeUnitOffset: given a flat UTF-16 code
 * unit offset, find the 1-based line and 0-based column it falls on.
 * @param {string} source
 * @param {number} offset flat UTF-16 code unit offset from the start of source
 * @returns {{line: number, column: number}}
 */
export function codeUnitOffsetToLineColumn(source, offset) {
  const lines = source.split('\n');
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLength = lines[i].length;
    if (offset <= cursor + lineLength) {
      return { line: i + 1, column: offset - cursor };
    }
    cursor += lineLength + 1; // +1 for the '\n' separator
  }
  // offset is past the end of source -- clamp to the end of the last line.
  const lastIndex = lines.length - 1;
  return { line: lastIndex + 1, column: lines[lastIndex].length };
}
