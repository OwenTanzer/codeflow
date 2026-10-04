import { cases } from './fixtures/full-label-cases.mjs';
import { labelGateFailures } from './full-label-gates.mjs';
import { chromium } from 'playwright';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {indexPythonSymbols} from '../server/lib/pythonSymbolIndex.js';
import {lineColumnToCodeUnitOffset} from '../src/graph-ir/codeUnitOffset.js';
import {adaptFunctionAnalysis} from '../src/adapters/functionGraphAdapter.js';
import {normalizeContext} from '../src/graph-ir/githubContext.js';
const require=createRequire(import.meta.url);
const source=readFileSync('tests/fixtures/python-symbols/requests-sessions-pinned.py','utf8');
const {entries}=await indexPythonSymbols({path:'src/requests/sessions.py',content:source});
const entrySymbol=entries.find(e=>e.symbolPath.join('.')==='SessionRedirectMixin.resolve_redirects');
const {initPythonLanguageService,analyzePythonFunction}=require('@codevisualizer/core');
await initPythonLanguageService();
const ir=await analyzePythonFunction(source,{startByte:lineColumnToCodeUnitOffset(source,entrySymbol.startLine,entrySymbol.startColumn),endByte:lineColumnToCodeUnitOffset(source,entrySymbol.endLine,entrySymbol.endColumn)});
const graph=adaptFunctionAnalysis({context:normalizeContext({owner:'psf',repo:'requests',resolvedSha:'611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60'}),entrySymbol,source,flowchartIR:ir,analyzer:{name:'label-review',version:'1'}});
writeFileSync('.git/run2-requests-graph.json',JSON.stringify(graph,null,2));

const completeness=[];
for(const fixture of cases) {
 const ir=await analyzePythonFunction(fixture.source,{startByte:0,endByte:fixture.source.trimEnd().length});
 const adapted=adaptFunctionAnalysis({context:graph.context,entrySymbol:{...entrySymbol,path:'fixture.py',symbolPath:['sample'],startLine:1,startColumn:0,endLine:fixture.source.trimEnd().split('\n').length,endColumn:0},source:fixture.source,flowchartIR:ir,analyzer:{name:'fixture',version:'1'}});
 const node=adapted.nodes.find(n=>n.id.startsWith(fixture.prefix));
 completeness.push({...fixture,graph:adapted,nodeId:node?.id,actual:node?.label,exact:node?.label===fixture.expected});
}
const browser=await chromium.launch();
const results={browser:browser.version(),fixtureRevision:graph.context.resolvedSha,warnings:graph.warnings,completeness,views:[]};
for(const viewport of [{width:1680,height:1000},{width:390,height:844}]) {
 const page=await browser.newPage({viewport});
 const fontResponses=[];
 page.on('response',r=>{if(/font|woff/.test(r.headers()['content-type']||''))fontResponses.push(r);});
 // Keep the production document, stylesheet and font declarations intact.
 await page.goto(process.env.LABEL_TEST_URL||'http://127.0.0.1:5128/',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.d3);
 await page.evaluate(()=>{
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.id='label-acceptance';
  svg.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;z-index:9999;background:#101218';
  document.body.append(svg);
 });
 await page.evaluate(async()=>{await document.fonts.load('500 11px "JetBrains Mono"');await document.fonts.ready;});
 const checks=await page.evaluate(async graph=>{
  const {renderFunctionGraph}=await import('/src/render/functionGraph.js');
  const {containsLabelBounds}=await import('/src/render/labelGeometry.js');
  const svg=document.querySelector('#label-acceptance'),zoomRef={current:null};
  const start=performance.now();
  const cleanup=renderFunctionGraph({svgEl:svg,graph,theme:'dark',zoomRef,selectSymbolRef:{},activateSymbolRef:{},onHover:()=>{},onBackgroundClick:()=>{}});
  const elapsed=performance.now()-start;
  const nodes=[...svg.querySelectorAll('.fn-nl')];
  const lost=[],overflow=[],shapeOverlap=[],edgeNodeOverlap=[],edgeLabelOverlap=[];
  for(const text of nodes) {
   const d=text.__data__;
   const actual=[...text.querySelectorAll('tspan')].map(t=>t.textContent).join('');
   const expected=d.label.replace(/\r\n?/g,'\n').replace(/\t/g,'    ').replace(/\n/g,'');
   if(actual!==expected)lost.push(d.id);
   const b=text.getBBox();
   if(!containsLabelBounds(d,b))overflow.push(d.id);
   for(const other of nodes) {
    const m=other.__data__;
    if(d.id<m.id && Math.abs(d.x-m.x)<(d.width+m.width)/2 && Math.abs(d.y-m.y)<(d.height+m.height)/2)shapeOverlap.push([d.id,m.id]);
   }
  }

  const intersects=(a,b)=>a.x<b.x+b.width && a.x+a.width>b.x && a.y<b.y+b.height && a.y+a.height>b.y;
  for(const path of svg.querySelectorAll('path[marker-end]')) {
   const l=path.__data__;
   if(!l?.points)continue;
   for(let i=1;i<l.points.length;i++) {
    const [a,b]=[l.points[i-1],l.points[i]];
    const rect={x:Math.min(a[0],b[0])-.8,y:Math.min(a[1],b[1])-.8,width:Math.abs(a[0]-b[0])+1.6,height:Math.abs(a[1]-b[1])+1.6};
    for(const t of nodes) {
     const n=t.__data__;
     if(n.id===l.source.id||n.id===l.target.id)continue;
     if(intersects(rect,{x:n.x-n.width/2,y:n.y-n.height/2,width:n.width,height:n.height}))edgeNodeOverlap.push([l.data.source,l.data.target,n.id]);
    }
   }
  }
  for(const text of svg.querySelectorAll('text:not(.fn-nl)')) {
   const b=text.getBBox();
   for(const t of nodes) {
    const n=t.__data__;
    if(intersects(b,{x:n.x-n.width/2,y:n.y-n.height/2,width:n.width,height:n.height}))edgeLabelOverlap.push([text.textContent,n.id]);
   }
  }
  const searches={};
  for(const q of ['resp','purged_headers','yield_requests','rewindable','TooManyRedirects']) {
   cleanup.applySearch(q);
   searches[q]=[...svg.querySelectorAll('.fn-nc')].filter(n=>n.getAttribute('stroke')==='#f0abfc').length;
  }
  cleanup.applySearch('');
  const zoom=[];
  for(const k of [.15,.55,1,4]) {
   d3.select(svg).call(zoomRef.current.transform,d3.zoomIdentity.scale(k));
   zoom.push({k,visible:nodes.filter(t=>getComputedStyle(t).visibility!=='hidden' && getComputedStyle(t).display!=='none').length});
  }
  // Pan each node's actual shape to the viewport center; all remain reachable.
  let reachable=0;
  for(const t of nodes) {
   const d=t.__data__;
   d3.select(svg).call(zoomRef.current.transform,d3.zoomIdentity.translate(svg.clientWidth/2-d.x,svg.clientHeight/2-d.y));
   const b=t.getBoundingClientRect();
   if(b.right>0&&b.left<svg.clientWidth&&b.bottom>0&&b.top<svg.clientHeight)reachable++;
  }
  const chosen=nodes.find(t=>t.__data__.label.includes('purged_headers'))||nodes[0];
  const d=chosen.__data__;
  const k=Math.min(1,(svg.clientWidth-32)/d.width);
  d3.select(svg).call(zoomRef.current.transform,d3.zoomIdentity.translate(svg.clientWidth/2-d.x*k,160-d.y*k).scale(k));
  window.labelCleanup=cleanup;
  return {elapsed,nodeCount:nodes.length,lost,overflow,shapeOverlap,edgeNodeOverlap,edgeLabelOverlap,searches,zoom,reachable,
   fontLoaded:document.fonts.check('500 11px "JetBrains Mono"'),
   labelProvenance:graph.nodes.reduce((o,n)=>(o[n.metadata.labelProvenance]=(o[n.metadata.labelProvenance]||0)+1,o),{})};
 },graph);
 await page.screenshot({path:'.git/run2-lane28-'+viewport.width+'.png'});


 const cdp=await page.context().newCDPSession(page);
 await cdp.send('DOM.enable');await cdp.send('CSS.enable');
 const {root}=await cdp.send('DOM.getDocument');
 const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:'#label-acceptance .fn-nl'});
 checks.platformFonts=(await cdp.send('CSS.getPlatformFontsForNode',{nodeId})).fonts;
 checks.fontLoaded=checks.platformFonts.some(f=>f.familyName.includes('JetBrains Mono')&&f.glyphCount>0);

 // Resize exercises the renderer's observer, with selection/search preserved.
 await page.evaluate(()=>window.labelCleanup.applySearch('purged_headers'));
 await page.setViewportSize({width:viewport.width===390?480:1200,height:viewport.height});
 await page.waitForTimeout(150);
 async function reflowCheck() {
  return page.evaluate(async()=>{
   const {containsLabelBounds}=await import('/src/render/labelGeometry.js');
   const svg=document.querySelector('#label-acceptance');
   const nodes=[...svg.querySelectorAll('.fn-nl')],failures=[];
   for(const t of nodes) {
    const d=t.__data__;
    if(!containsLabelBounds(d,t.getBBox()))failures.push(d.id+':containment');
    if([...t.querySelectorAll('tspan')].map(t=>t.textContent).join('')!==d.label.replace(/\r\n?/g,'\n').replace(/\t/g,'    ').replace(/\n/g,''))failures.push(d.id+':text');
   }
   for(const t of svg.querySelectorAll('text:not(.fn-nl)')) {
    const b=t.getBBox();
    for(const n of nodes.map(t=>t.__data__))if(b.x<n.x+n.width/2&&b.x+b.width>n.x-n.width/2&&b.y<n.y+n.height/2&&b.y+b.height>n.y-n.height/2)failures.push('edge-label:'+n.id);
   }
   return {failures,nodeCount:nodes.length,searchMatches:[...svg.querySelectorAll('.fn-nc')].filter(n=>n.getAttribute('stroke')==='#f0abfc').length};
  });
 }
 checks.resize=await reflowCheck();
 await page.setViewportSize(viewport);
 await page.waitForTimeout(100);
 // Recreate the actual downloaded production face with an intentionally late
 // response. This is controlled font-load emulation, not a different font.
 const fontResponse=fontResponses.find(r=>r.ok());
 if(fontResponse) {
  const bytes=await fontResponse.body();
  await page.route('**/lane28-late-font.woff2',async route=>{
   await new Promise(resolve=>setTimeout(resolve,200));
   await route.fulfill({status:200,contentType:'font/woff2',body:bytes});
  });
  await page.evaluate(async graph=>{
   window.labelCleanup?.();
   for(const face of document.fonts)if(face.family.includes('JetBrains Mono'))document.fonts.delete(face);
   const {renderFunctionGraph}=await import('/src/render/functionGraph.js');
   window.labelCleanup=renderFunctionGraph({svgEl:document.querySelector('#label-acceptance'),graph,theme:'dark',zoomRef:{},selectSymbolRef:{},activateSymbolRef:{},onHover:()=>{},onBackgroundClick:()=>{}});
   const face=new FontFace('JetBrains Mono','url(/lane28-late-font.woff2)',{weight:'500'});
   document.fonts.add(face);
   await document.fonts.load('500 11px "JetBrains Mono"');
   await document.fonts.ready;
  },graph);
  await page.waitForTimeout(150);
  checks.lateFont=await reflowCheck();
 } else checks.lateFont={failures:['No production font response available']};

 checks.sourceBrowser=[];
 for(const fixture of completeness) {
  const exact=await page.evaluate(async f=>{
   window.labelCleanup?.();
   const {renderFunctionGraph}=await import('/src/render/functionGraph.js');
   window.labelCleanup=renderFunctionGraph({svgEl:document.querySelector('#label-acceptance'),graph:f.graph,theme:'dark',zoomRef:{},selectSymbolRef:{},activateSymbolRef:{},onHover:()=>{},onBackgroundClick:()=>{}});
   const t=[...document.querySelectorAll('#label-acceptance .fn-nl')].find(t=>t.__data__.id===f.nodeId);
   return !!t&&[...t.querySelectorAll('tspan')].map(t=>t.textContent).join('')===f.expected.replace(/\r\n?/g,'\n').replace(/\t/g,'    ').replace(/\n/g,'');
  },fixture);
  checks.sourceBrowser.push({name:fixture.name,exact});
  if(!exact)fixture.exact=false;
 }
 checks.overview = await page.evaluate(async()=>{
  const {renderRepositoryGraph}=await import('/src/render/repositoryGraph.js');
  const {renderFileGraph}=await import('/src/render/fileGraph.js');
  window.labelCleanup?.();
  const label='full_name.with-punctuation_():'+ 'long_identifier_'.repeat(12)+'.py';
  const svg=document.querySelector('#label-acceptance'), result={};
  for(const layer of ['repository','file']) {
   const zoomRef={},simRef={};
   const common={svgEl:svg,theme:'dark',zoomRef,simRef,onHover:()=>{},onBackgroundClick:()=>{}};
   const cleanup=layer==='repository' ? renderRepositoryGraph({...common,
    data:{layer:'repository',nodes:[{id:'n',label,metadata:{folder:'folder_with_complete_name'},coordinate:{path:'folder_with_complete_name/'+label}}],edges:[]},
    colorMap:{},colorMode:'folder',graphConfig:{viewMode:'force',spacing:200,linkDist:70,showLabels:true},
    COLORS:['#fff'],LAYER_COLORS:{},nodesRef:{},linksRef:{},selectFileRef:{},activateFileRef:{}})
    :renderFileGraph({...common,graph:{nodes:[{id:'n',label,kind:'function'}],edges:[]},selectSymbolRef:{},activateSymbolRef:{}});
   await new Promise(resolve=>setTimeout(resolve,150));
   const texts=()=>[...svg.querySelectorAll('text')];
   d3.select(svg).call(zoomRef.current.transform,d3.zoomIdentity.scale(.2));
   await new Promise(resolve=>setTimeout(resolve,150));
   const hidden=texts().every(t=>getComputedStyle(t).visibility==='hidden');
   d3.select(svg).call(zoomRef.current.transform,d3.zoomIdentity.scale(1));
   await new Promise(resolve=>setTimeout(resolve,150));
   result[layer]={hidden,restored:texts().every(t=>getComputedStyle(t).visibility==='visible'),exact:texts().some(t=>t.textContent===label)&&(layer!=='repository'||texts().some(t=>t.textContent==='folder_with_complete_name'))};
   cleanup();
  }
  return result;
 });
 results.views.push({viewport,...checks});
 await page.close();
}
await browser.close();
writeFileSync('.git/run2-browser.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
const failures=labelGateFailures(results);
console.log('Acceptance failures:',JSON.stringify(failures));
if(failures.length)process.exitCode=1;
