// Exact wrapping and geometry shared by the renderer and layout.
// Soft wraps add no characters. Only CRLF -> LF and tabs -> four spaces are
// layout whitespace normalization; source labels themselves remain unchanged.
export const LABEL_FONT = '500 11px "JetBrains Mono", monospace';
export const LINE_HEIGHT = 16;
export function wrapMeasuredText(label, measure, maxWidth = 300) {
  const lines = [];
  for (const paragraph of String(label ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
    let rest = Array.from(paragraph);
    if (!rest.length) lines.push('');
    while (rest.length) {
      let lo = 1, hi = rest.length, take = 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (measure(rest.slice(0, mid).join('')) <= maxWidth) { take = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      // Keep punctuation AND whitespace on one side of the boundary.
      if (take < rest.length) {
        for (let i = take - 1; i >= Math.floor(take * 0.6); i--) {
          if (/[\s_.\-(),:]/u.test(rest[i])) { take = i + 1; break; }
        }
      }
      lines.push(rest.splice(0, take).join(''));
    }
  }
  return lines;
}
export function measureFunctionNode(node, measure = s => Array.from(s).length * 7, maxWidth = 300) {
  const lines = wrapMeasuredText(node.label, measure, maxWidth);
  const textWidth = Math.max(0, ...lines.map(measure));
  const textHeight = lines.length * LINE_HEIGHT;
  let width = Math.max(64, textWidth + 28), height = Math.max(36, textHeight + 20);
  if (node.kind === 'branch' || node.hints?.shape === 'diamond') {
    width *= 2; height *= 2; // text rectangle lies inside the diamond
  } else if (node.kind === 'entry' || node.kind === 'exit') {
    width *= Math.SQRT2; height *= Math.SQRT2; // enclosing ellipse
  }
  return { lines, width, height, textWidth, textHeight };
}
