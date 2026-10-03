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
writeFileSync('.git/requests-graph.json',JSON.stringify(graph,null,2));
const browser=await chromium.launch();
const results={browser:browser.version(),fixtureRevision:graph.context.resolvedSha,warnings:graph.warnings,views:[]};
for(const viewport of [{width:1680,height:1000},{width:390,height:844}]) {
 const page=await browser.newPage({viewport});
 await page.goto('http://127.0.0.1:5128/');
 await page.setContent('<style>body{margin:0;background:#101218}svg{width:100vw;height:100vh}</style><svg></svg>');
 await page.addScriptTag({url:'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js'});
 const checks=await page.evaluate(async graph=>{
  const {renderFunctionGraph}=await import('/src/render/functionGraph.js');
  const svg=document.querySelector('svg'),zoomRef={current:null};
  const start=performance.now();
  const cleanup=renderFunctionGraph({svgEl:svg,graph,theme:'dark',zoomRef,selectSymbolRef:{},activateSymbolRef:{},onHover:()=>{},onBackgroundClick:()=>{}});
  const elapsed=performance.now()-start;
  const nodes=[...svg.querySelectorAll('.fn-nl')];
  const lost=[],overflow=[],shapeOverlap=[];
  for(const text of nodes) {
   const d=text.__data__;
   const actual=[...text.querySelectorAll('tspan')].map(t=>t.textContent).join('');
   const expected=d.label.replace(/\r\n?/g,'\n').replace(/\t/g,'    ').replace(/\n/g,'');
   if(actual!==expected)lost.push(d.id);
   const b=text.getBBox();
   if(b.x < -d.width/2 || b.x+b.width > d.width/2 || b.y < -d.height/2 || b.y+b.height > d.height/2)overflow.push(d.id);
   for(const other of nodes) {
    const m=other.__data__;
    if(d.id<m.id && Math.abs(d.x-m.x)<(d.width+m.width)/2 && Math.abs(d.y-m.y)<(d.height+m.height)/2)shapeOverlap.push([d.id,m.id]);
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
  return {elapsed,nodeCount:nodes.length,lost,overflow,shapeOverlap,searches,zoom,reachable,
   labelProvenance:graph.nodes.reduce((o,n)=>(o[n.metadata.labelProvenance]=(o[n.metadata.labelProvenance]||0)+1,o),{})};
 },graph);
 await page.screenshot({path:'.git/lane28-'+viewport.width+'.png'});

 checks.overview = await page.evaluate(async()=>{
  const {renderRepositoryGraph}=await import('/src/render/repositoryGraph.js');
  const {renderFileGraph}=await import('/src/render/fileGraph.js');
  const label='full_name.with-punctuation_():'+ 'long_identifier_'.repeat(12)+'.py';
  const svg=document.querySelector('svg'), result={};
  for(const layer of ['repository','file']) {
   const zoomRef={},simRef={};
   const common={svgEl:svg,theme:'dark',zoomRef,simRef,onHover:()=>{},onBackgroundClick:()=>{}};
   const cleanup=layer==='repository' ? renderRepositoryGraph({...common,
    data:{layer:'repository',nodes:[{id:'n',label,coordinate:{path:label}}],edges:[]},
    colorMap:{},colorMode:'folder',graphConfig:{viewMode:'force',spacing:200,linkDist:70,showLabels:true},
    COLORS:['#fff'],LAYER_COLORS:{},nodesRef:{},linksRef:{},selectFileRef:{},activateFileRef:{}})
    :renderFileGraph({...common,graph:{nodes:[{id:'n',label,kind:'function'}],edges:[]},selectSymbolRef:{},activateSymbolRef:{}});
   simRef.current.stop();
   const texts=[...svg.querySelectorAll('text')].filter(t=>t.__data__?.id);
   d3.select(svg).call(zoomRef.current.transform,d3.zoomIdentity.scale(.2));
   const hidden=texts.every(t=>getComputedStyle(t).visibility==='hidden');
   d3.select(svg).call(zoomRef.current.transform,d3.zoomIdentity.scale(1));
   result[layer]={hidden,restored:texts.every(t=>getComputedStyle(t).visibility==='visible'),exact:texts.length===1&&texts[0].textContent===label};
   cleanup();
  }
  return result;
 });
 results.views.push({viewport,...checks});
 await page.close();
}
await browser.close();
writeFileSync('.git/lane28-browser.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
if(results.views.some(v=>v.lost.length||v.overflow.length||v.shapeOverlap.length||v.reachable!==v.nodeCount||Object.values(v.overview).some(o=>!o.hidden||!o.restored||!o.exact)))process.exitCode=1;
