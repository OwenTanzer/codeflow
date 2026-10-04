// Replay a captured real repository graph through the production renderer.
import {chromium} from 'playwright';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
const [base='http://127.0.0.1:5134/',input='test-results/integration/simbrain-cold.json',out='test-results/dense-labels']=process.argv.slice(2);
mkdirSync(out,{recursive:true});
const graph=JSON.parse(readFileSync(input)).graph;
const browser=await chromium.launch(),page=await browser.newPage({viewport:{width:1400,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.goto(base);await page.waitForFunction(()=>window.d3);await page.evaluate(()=>document.fonts.ready);
await page.evaluate(async graph=>{
 const {renderRepositoryGraph}=await import('/src/render/repositoryGraph.js');
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.id='dense-test';svg.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;background:#fff;z-index:99999';document.body.append(svg);
 const refs={zoomRef:{},simRef:{},linksRef:{},nodesRef:{},selectFileRef:{},activateFileRef:{}};
 window.__dense={svg,refs,dispose:renderRepositoryGraph({svgEl:svg,data:graph,colorMap:{},colorMode:'folder',theme:'light',folderFilter:null,graphConfig:{viewMode:'force',spacing:180,linkDist:80,showLabels:true,curvedLinks:false},COLORS:['#278'],LAYER_COLORS:{utils:'#278'},...refs,onHover:()=>{},onBackgroundClick:()=>{}})};
},graph);
await page.waitForFunction(()=>window.__dense.refs.simRef.current.alpha()<0.001,null,{timeout:30000});
const result=await page.evaluate(()=>{
 const {svg,refs}=window.__dense;
 const texts=[...svg.querySelectorAll('g.graph-interactive-node > text')];
 const rects=texts.map(t=>{const b=t.getBBox(),d=t.__data__;return{x:d.x+b.x,y:d.y+b.y,w:b.width,h:b.height,id:d.id,text:t.textContent};});
 let overlap=0;const examples=[];
 for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j];if(a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y){overlap++;if(examples.length<10)examples.push([a.id,b.id]);}}
 const expected=new Map(refs.nodesRef.current.data().map(n=>[n.id,n.name]));
 const lost=rects.filter(r=>r.text!==expected.get(r.id)).map(r=>r.id);
 for(const k of [.2,1])d3.select(svg).call(refs.zoomRef.current.transform,d3.zoomIdentity.scale(k));
 return{nodes:rects.length,overlap,examples,lost,visibleAtOne:texts.every(t=>getComputedStyle(t).visibility==='visible')};
});
await page.screenshot({path:out+'/dense.png'});await page.evaluate(()=>window.__dense.dispose());await browser.close();
writeFileSync(out+'/results.json',JSON.stringify({mode:'captured real graph replay; not fresh retrieval',browser:browser.version(),...result,errors},null,2));console.log(JSON.stringify(result));
assert.equal(errors.length,0);assert.equal(result.lost.length,0);assert.equal(result.visibleAtOne,true);assert.equal(result.overlap,0);
