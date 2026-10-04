// Local UI fixture only. It does not stand in for live GitHub acceptance.
import {readFileSync} from 'node:fs';
export async function installLabelAppFixture(page){
 const fn=JSON.parse(readFileSync('.git/run2-requests-graph.json','utf8'));
 fn.context.ref=fn.context.resolvedSha;
 const coordinate=fn.rootCoordinate;
 const file={...fn,layer:'file',nodes:[
  {id:'module',kind:'module',layer:'file',label:'sessions.py',coordinate:{...coordinate,symbolPath:[],symbolKind:'module',range:null},hints:{shape:'rect'},origin:'local'},
  {id:'class',kind:'class',layer:'file',label:'SessionRedirectMixin',coordinate:{...coordinate,symbolPath:['SessionRedirectMixin'],symbolKind:'class'},hints:{shape:'rect'},origin:'local'},
  {id:'resolve',kind:'method',layer:'file',label:'resolve_redirects',coordinate,hints:{shape:'rect'},origin:'local'},
  {id:'other',kind:'method',layer:'file',label:'get_redirect_target',coordinate:{...coordinate,symbolPath:['SessionRedirectMixin','get_redirect_target']},hints:{shape:'rect'},origin:'local'}
 ],edges:[{id:'e1',source:'module',target:'class',kind:'defines'},{id:'e2',source:'class',target:'resolve',kind:'defines'},{id:'e3',source:'class',target:'other',kind:'defines'}],warnings:[]};
 const repo={...fn,layer:'repository',rootCoordinate:null,nodes:[{id:'sessions',layer:'repository',kind:'file',label:'sessions.py',
  coordinate:{...coordinate,symbolPath:[],symbolKind:'module',range:null},
  metadata:{folder:'src/requests',lines:831,layer:'util',functionCount:2,dependencies:[]},hints:{shape:'circle'},origin:'local'}],
  edges:[],metadata:{folders:['src/requests'],functions:[],tree:{name:'root',path:'',children:{},files:[]},
   stats:{files:1,functions:2,connections:0,loc:831,dead:0,languages:[{ext:'.py',count:1,pct:100}]}}};
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  const graph=path==='/api/graph/repository'?repo:path==='/api/graph/file'?file:path==='/api/graph/function'?fn:null;
  if(graph)return route.fulfill({json:{graph,status:'ok',warnings:[],cache:{key:'local-fixture:'+path}}});
  if(path==='/api/capabilities')return route.fulfill({json:{fileLayerEnabled:true,functionLayerEnabled:true}});
  return route.fulfill({status:503,json:{error:{message:'Unavailable in local label UI fixture',code:'FIXTURE_UNAVAILABLE'}}});
 });
 console.log('FIXTURE MODE: local Requests parser graph plus synthetic repository/file envelope; no live GitHub acceptance.');
}
