import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapMeasuredText, measureFunctionNode } from '../src/render/labelGeometry.js';
import { buildFunctionRenderModel } from '../src/render/functionRenderModel.js';
import { forwardPath, backPath } from '../src/render/functionGraph.js';
import { recoverFunctionLabel } from '../src/adapters/functionGraphAdapter.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const label = 'get_redirect_target_' + 'unbroken_identifier'.repeat(12) + '._-(),:"<>\\\\"...';
test('wrapping preserves every character at every punctuation boundary', () => {
  for (let width = 7; width < 150; width++) {
    assert.equal(wrapMeasuredText(label, s => s.length * 7, width).join(''), label);
  }
  assert.deepEqual(wrapMeasuredText('a\nb\nc\nd', s => s.length * 7), ['a','b','c','d']);
});
test('all shapes enclose measured multiline text and layout uses final geometry', () => {
  const nodes = ['process','call','branch','entry','exit'].map((kind,i) => ({
    id: String(i), kind, label: label + '\nsecond\nthird\nfourth',
    hints: { shape: kind === 'branch' ? 'diamond' : 'rect', isEntry: kind === 'entry', isExit: kind === 'exit' },
  }));
  const edges = nodes.slice(1).map((n,i) => ({source: String(i), target:n.id, kind:'flow'}));
  const model = buildFunctionRenderModel({nodes,edges}, {measureText:s=>s.length*7,maxTextWidth:140});
  for (const n of model.nodes) {
    assert.ok(n.width >= n.textWidth + 28);
    assert.ok(n.height >= n.textHeight + 20);
    assert.ok(n.x-n.width/2 >= 0 && n.x+n.width/2 <= model.width);
    assert.ok(n.y-n.height/2 >= 0 && n.y+n.height/2 <= model.height);
    for (const m of model.nodes) if (n.id!==m.id) {
      assert.ok(Math.abs(n.x-m.x)>=(n.width+m.width)/2 || Math.abs(n.y-m.y)>=(n.height+m.height)/2);
    }
  }
  const [s,t] = model.nodes;
  assert.ok(forwardPath(s,t).startsWith('M'+s.x+','+(s.y+s.height/2)));
  assert.ok(forwardPath(s,t).endsWith('V'+(t.y-t.height/2)));
  assert.ok(backPath(t,s,0,model.width+40).startsWith('M'+(t.x+t.width/2)+','+t.y));
});
test('real upstream analysis recovers long and multiline source labels without entity artifacts', async () => {
  const {initPythonLanguageService,analyzePythonFunction} = require('@codevisualizer/core');
  await initPythonLanguageService();
  const statement = '    purged_headers = ("' + 'header_'.repeat(30) + '",\n        "quote: \\" < > ...",\n        "third-line",\n        "fourth-line")';
  const source = 'def fixture(resp):\n' + statement + '\n    if resp.' + 'long_identifier_'.repeat(20) + ' > 10:\n        return resp\n';
  const ir = await analyzePythonFunction(source,{startByte:0,endByte:source.trimEnd().length});
  const assignment = ir.nodes.find(n => n.location && source.slice(n.location.start,n.location.end).startsWith('purged_headers'));
  assert.ok(assignment);
  assert.ok(assignment.label.length <= 80, 'fixture exceeds actual upstream limit');
  const recovered = recoverFunctionLabel(assignment,source);
  assert.equal(recovered.provenance,'verified-source-span');
  assert.equal(recovered.label,statement.trimStart());
  assert.ok(recovered.label.includes('\\" < > ...'));
  const condition = ir.nodes.find(n=>n.nodeType==='decision');
  assert.equal(recoverFunctionLabel(condition,source).label,source.slice(condition.location.start,condition.location.end));
});
test('unrelated source spans never replace generated upstream labels',()=>{
  assert.deepEqual(recoverFunctionLabel({label:'end loop',location:{start:0,end:10}},'for x in y:\n    pass'),
    {label:'end loop',provenance:'upstream-label'});
});

test('a long generated loop header must not recover the entire loop body',()=>{
  const source='for item in '+ 'identifier'.repeat(20)+':\n    side_effect()';
  const label=source.slice(0,77)+'...';
  assert.equal(recoverFunctionLabel({id:'for_header_1',label,location:{start:0,end:source.length}},source).provenance,'upstream-label');
});
