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

// Check the actual shape, not just its enclosing rectangle.
export function containsLabelBounds(node, box, epsilon = 0.01) {
  const hw = node.width / 2, hh = node.height / 2;
  return [box.x, box.x + box.width].every(x =>
    [box.y, box.y + box.height].every(y => {
      if (node.isEntry || node.isExit) return (x/hw)**2 + (y/hh)**2 <= 1 + epsilon;
      if (node.shape === 'diamond') return Math.abs(x)/hw + Math.abs(y)/hh <= 1 + epsilon;
      return Math.abs(x) <= hw + epsilon && Math.abs(y) <= hh + epsilon;
    }));
}

// Horizontal channels live in the whitespace BETWEEN complete rank bounds.
// Rank-skipping edges and loops use distinct external vertical lanes, so
// neither their path nor arrowhead can cut across an intermediate node.
export function routeFunctionLinks(model) {
  const byId = new Map(model.nodes.map(n => [n.id,n]));
  const rows = new Map();
  for (const n of model.nodes) {
    const row = rows.get(n.rank) || {top:Infinity,bottom:-Infinity,used:0};
    row.top = Math.min(row.top,n.y-n.height/2);
    row.bottom = Math.max(row.bottom,n.y+n.height/2);
    rows.set(n.rank,row);
  }
  const right = Math.max(...model.nodes.map(n=>n.x+n.width/2));
  let lane = 0;
  return model.links.map(data=>{
    const source=byId.get(data.source),target=byId.get(data.target);
    const row=rows.get(source.rank);
    const y=row.bottom+20+row.used++*20;
    const start=[source.x,source.y+source.height/2];
    const end=[target.x,target.y-target.height/2];
    const external=data.isBackEdge || target.rank!==source.rank+1;
    const x=external ? right+40+lane++*20 : target.x;
    const points=[start,[source.x,y],[x,y]];
    if(external)points.push([x,rows.get(target.rank).top-16],[target.x,rows.get(target.rank).top-16]);
    points.push(end);
    return {data,source,target,points,
      d:points.map((p,i)=>(i?'L':'M')+p[0]+','+p[1]).join(''),
      labelX:external?x+6:Math.max(source.x,target.x)+8,labelY:y-4};
  });
}
