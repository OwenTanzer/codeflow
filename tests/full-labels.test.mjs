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

import { containsLabelBounds, routeFunctionLinks } from '../src/render/labelGeometry.js';
import { labelGateFailures } from './full-label-gates.mjs';
test('acceptance gates fail on hidden function labels and missing search matches',()=>{
  const pass={views:[{nodeCount:2,reachable:2,zoom:[{k:.15,visible:2}],
    searches:{resp:1,purged_headers:1,yield_requests:1,rewindable:1,TooManyRedirects:1},fontLoaded:true}],completeness:[{exact:true}]};
  assert.deepEqual(labelGateFailures(pass),[]);
  for(const mutate of [
    r=>{r.views[0].zoom[0].visible=1;},
    r=>{r.views[0].searches.purged_headers=0;},
    r=>{r.completeness[0].exact=false;},
    r=>{r.views[0].fontLoaded=false;},
    r=>{r.views[0].edgeLabelOverlap=['false/for'];}
  ]) {const r=structuredClone(pass);mutate(r);assert.ok(labelGateFailures(r).length);}
});
test('diamond and ellipse containment reject corners inside the bounding rectangle',()=>{
  for(const node of [{shape:'diamond'},{isEntry:true}]){
    assert.equal(containsLabelBounds({...node,width:100,height:100},{x:35,y:35,width:10,height:10}),false);
    assert.equal(containsLabelBounds({...node,width:100,height:100},{x:-10,y:-10,width:20,height:20}),true);
  }
});
test('rank skipping and loop routes clear all unrelated node rectangles',()=>{
 const nodes=Array.from({length:7},(_,i)=>({id:String(i),kind:i===2?'branch':'process',label:label.repeat(2),hints:{shape:i===2?'diamond':'rect'}}));
 const edges=nodes.slice(1).map((n,i)=>({source:String(i),target:n.id,kind:'flow'}));
 edges.push({source:'0',target:'6',kind:'flow-false'},{source:'5',target:'1',kind:'flow'});
 const model=buildFunctionRenderModel({nodes,edges});
 for(const l of routeFunctionLinks(model)){
  assert.deepEqual(l.points[0],[l.source.x,l.source.y+l.source.height/2]);
  assert.deepEqual(l.points.at(-1),[l.target.x,l.target.y-l.target.height/2]);
  for(const n of model.nodes){
   if(n===l.source||n===l.target)continue;
   for(let i=1;i<l.points.length;i++){
    const [a,b]=[l.points[i-1],l.points[i]];
    const hit=Math.max(a[0],b[0])>n.x-n.width/2&&Math.min(a[0],b[0])<n.x+n.width/2&&
      Math.max(a[1],b[1])>n.y-n.height/2&&Math.min(a[1],b[1])<n.y+n.height/2;
    assert.equal(hit,false,l.data.source+' -> '+l.data.target+' crosses '+n.id);
   }
  }
 }
});

test('versioned authoritative raw labels bypass Mermaid decoding without losing provenance',()=>{
 const text='#quot; literal ...\n'+label;
 assert.deepEqual(recoverFunctionLabel({label:'shortened...',rawLabel:{version:1,text,provenance:'python-parser-composition'}},''),
   {label:text,provenance:'python-parser-composition'});
 const model=buildFunctionRenderModel({nodes:[{id:'raw',kind:'process',label:text,
   metadata:{rawLabel:{version:1,text,provenance:'python-parser-composition'},labelProvenance:'python-parser-composition'}}],edges:[]});
 assert.equal(model.nodes[0].rawLabel.text,text);
 assert.equal(model.nodes[0].labelProvenance,'python-parser-composition');
});
