// MOO-71 Commit 5: converts a tree-sitter row/column position (as
// produced by server/lib/pythonSymbolIndex.js's startLine/startColumn/
// endLine/endColumn) into a flat index -- the unit
// @codevisualizer/core's analyzePythonFunction expects as
// startByte/endByte.
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
// independently-parsed startIndex/endIndex exactly. So despite the
// "byte" naming (inherited from @codevisualizer/core's own
// startByte/endByte parameter names, which are themselves a slight
// misnomer for this binding), this conversion is plain UTF-16 code unit
// arithmetic -- do not "fix" this to use Buffer.byteLength, that would
// reintroduce the bug this comment documents. See
// tests/server-graph-function.test.mjs for the committed regression
// test.

/**
 * @param {string} source
 * @param {number} line 1-based
 * @param {number} column 0-based, UTF-16 code unit offset within the line
 * @returns {number} flat UTF-16 code unit offset from the start of source
 */
export function lineColumnToByteOffset(source, line, column) {
  const lines = source.split('\n');
  let offset = 0;
  for (let i = 0; i < line - 1; i++) {
    offset += lines[i].length + 1; // +1 for the '\n' separator
  }
  offset += column;
  return offset;
}
