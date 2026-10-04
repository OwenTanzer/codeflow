// Local-only #27 acceptance. Live source paths plus explicitly marked replay/fault tests.
// Usage: node tests/interaction-repairs-smoke.mjs http://localhost:4327/ <evidence-dir>
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const [base='http://localhost:4327/', out='interaction-evidence'] = process.argv.slice(2);
if (!['localhost','127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local test only');
await mkdir(out,{recursive:true});
const SHA='611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60', PATH='src/requests/sessions.py';
const browser=await chromium.launch();
const replayOnly=process.env.INTERACTION_REPLAY_ONLY==='1';
const fixtures=replayOnly?JSON.parse(await readFile(join(out,'pinned-api-fixtures.json'),'utf8')):{}, results=[], requests=[], errors=[], captures=[];
const identity=r=>{const b=r.postData()?r.postDataJSON():{};return {method:r.method(),endpoint:new URL(r.url()).pathname,owner:b.owner??null,repo:b.repo??null,revision:b.ref??b.resolvedSha??null,path:b.path??null,symbolPath:b.symbolPath??null,coordinate:b.coordinate??null};};
const key=r=>JSON.stringify(identity(r));
const captureTasks=[];
function validate(entry){
 const id=entry.identity,g=entry.data.graph;
 if(g){assert.equal(g.context.owner,id.owner);assert.equal(g.context.repo,id.repo);
 if(id.revision&&/^[0-9a-f]{40}$/.test(id.revision))assert.equal(g.context.resolvedSha,id.revision);
 if(id.path){assert.equal(g.rootCoordinate.path,id.path);assert.equal(g.rootCoordinate.revision,id.revision);}
 if(id.symbolPath)assert.deepEqual(g.rootCoordinate.symbolPath,id.symbolPath);}
 return entry;
}
function capture(p){p.on('response',r=>{if(!r.url().includes('/api/'))return;captureTasks.push((async()=>{const request=r.request(), id=identity(request);const data=await r.json();assert.equal(r.status(),200,'live capture '+JSON.stringify(id));fixtures[key(request)]=validate({identity:id,status:r.status(),data});captures.push({identity:id,status:r.status(),graphContext:data.graph?.context||null,rootCoordinate:data.graph?.rootCoordinate||null});})().catch(e=>errors.push('capture: '+e.message)));});}
let phase='', expectHttpError=false, expectFatal=false;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function watch(page) {
  const name=phase;page.setDefaultTimeout(15000);
  page.on('pageerror',e=>{if(!(expectFatal&&e.message==='Controlled local boundary test'))errors.push(name+': '+e.message);});
  page.on('console',m=>{
    if(m.type()==='error'&&!(expectFatal&&/Controlled local boundary test/.test(m.text()))&&!(expectHttpError&&/Failed to load resource.*502/.test(m.text())&&/\/api\/github\/(blame|file-content)$/.test(m.location().url)))
      errors.push(phase+': '+m.text());
  });
  page.on('request',r=>{
    if(r.url().includes('/api/')) {
      const body=r.postData()?r.postDataJSON():null;
      if(r.headers().authorization)errors.push(name+': browser Authorization header');
      requests.push({phase:name,url:new URL(r.url()).pathname,body,identity:identity(r),authorizationPresent:!!r.headers().authorization});
    }
  });
}
async function check(name,fn) {
  phase=name;
  const startErrors=errors.length;
  try {await fn();assert.equal(errors.length,startErrors,'unexpected console/page or replay error');results.push({name,status:'PASS'});console.log('PASS '+name);}
  catch(e){
    const p=browser.contexts().at(-1)?.pages().at(-1);
    if(p)await p.screenshot({path:join(out,'failure-'+name.replace(/[^a-z0-9]/gi,'-')+'.png')}).catch(()=>{});
    results.push({name,status:'FAIL',error:e.message});console.log('FAIL '+name+' '+e.message);}
  finally {for(const c of browser.contexts())await c.close();expectHttpError=false;expectFatal=false;await Promise.all(captureTasks);}
}
async function load(page,ref=SHA) {
  await page.goto(base);
  await page.waitForFunction(()=>typeof window.fetchRepositoryGraph==='function');
  // The current toolbar strips /tree/ref. Supply the explicit test ref at
  // its existing bridge seam; leave product request semantics unchanged.
  if(ref)await page.evaluate(ref=>{
    const original=window.fetchRepositoryGraph;
    window.fetchRepositoryGraph=input=>original({...input,ref});
  },ref);
  await page.getByRole('textbox',{name:'Repository URL',exact:true}).first().fill(ref?'https://github.com/psf/requests/tree/'+ref:'psf/requests');
  await page.getByRole('textbox',{name:'Repository URL',exact:true}).first().press('Enter');
  await page.getByTestId('revision-badge').waitFor({state:'attached',timeout:300000});
}
const fileNode=p=>p.getByRole('button',{name:'Open file: '+PATH,exact:true});
const fnNode=p=>p.getByRole('button',{name:'Open function: resolve_redirects',exact:true});
const back=p=>p.getByRole('button',{name:'← Back',exact:true});
async function fileReady(p){await p.locator('svg path.nc').first().waitFor({timeout:120000});}
async function fnReady(p){await p.locator('svg path.fn-nc').first().waitFor({timeout:120000});}
async function openSelected(p) {
  await p.getByRole('combobox',{name:'Function to open'}).selectOption({label:'SessionRedirectMixin.resolve_redirects'});
  const button=p.getByRole('button',{name:'Open function',exact:true});
  await button.focus();assert.ok(await button.evaluate(e=>document.activeElement===e));
  await button.press('Enter');await fnReady(p);
}
let page;
if(!replayOnly){
// The local server has a fixed 60-second API window. Prior smoke runs may
// share this client IP; wait a normal window instead of changing its limit.
console.log('Live phase: waiting one normal 60-second rate window');
await pause(60050);
await check('live pinned fixture',async()=>{
  page=await browser.newPage({viewport:{width:1680,height:1000}});watch(page);capture(page);
  await load(page);
  await fileNode(page).click();
  await page.locator('.card-header').filter({hasText:'Ownership'}).click();
  await page.locator('.owner-list').waitFor({timeout:60000});
  await page.getByRole('button',{name:'View Source',exact:true}).click();
  await page.locator('.file-preview-code').waitFor({timeout:60000});
  await selectable(page,page.locator('.file-preview-line').nth(1).locator('span').last());
  await page.screenshot({path:join(out,'source-selection.png')});
  assert.ok(requests.some(r=>r.phase===phase&&r.url==='/api/github/file-content'),'actual missing-content fallback');
  await page.locator('.file-preview-close').click();
  await page.getByRole('button',{name:'Open file',exact:true}).focus();
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Open file');
  await page.keyboard.press('Enter');await fileReady(page);
  await openSelected(page);
  await page.screenshot({path:join(out,'desktop-function.png')});
  await back(page).click();await fileReady(page);await back(page).click();
  for(const r of requests.filter(r=>r.phase===phase&&/github\/(blame|file-content)|graph\/(file|function)/.test(r.url))){
    assert.equal(r.body.owner,'psf');assert.equal(r.body.repo,'requests');
    assert.equal(r.body.ref||r.body.resolvedSha,SHA);
  }
  // Capture the second file once; replay must never substitute sessions.py.
  await page.getByRole('button',{name:'Open file: src/requests/models.py',exact:true}).dblclick();await fileReady(page);
  await Promise.all(captureTasks);
});
await writeFile(join(out,'pinned-api-fixtures.json'),JSON.stringify(fixtures,null,2));
console.log('Ref matrix: waiting one normal 60-second rate window');
await pause(60050);
await check('live omitted / branch / tag / SHA revision chain',async()=>{
  page=await browser.newPage({viewport:{width:1680,height:1000}});watch(page);
  for(const ref of [null,'main','v2.32.5',SHA]){
    await load(page,ref);
    const title=await page.getByTestId('revision-badge').getAttribute('title');
    assert.ok(title.startsWith('psf/requests '+(ref||'default branch')+'@'),title);
    const resolved=title.split('@').at(-1);
    const before=requests.length;
    await fileNode(page).click();
    await page.getByRole('button',{name:'Open file',exact:true}).click();await fileReady(page);
    await openSelected(page);await back(page).click();await fileReady(page);await back(page).click();
    assert.equal(await page.getByTestId('revision-badge').getAttribute('title'),title);
    for(const r of requests.slice(before).filter(r=>/github\/blame|graph\/(file|function)/.test(r.url))){
      assert.equal(r.body.owner,'psf');assert.equal(r.body.repo,'requests');
      assert.equal(r.body.ref||r.body.resolvedSha,resolved);
    }
    console.log('  ref='+ref+' resolved='+resolved);
  }
});
}
// Replay the actual pinned source responses to isolate gestures/faults from
// GitHub rate limits. This is browser touch emulation, NOT an iOS/Android test.
async function replay(p){
  await p.route('**/api/**',async route=>{
    const id=identity(route.request()), entry=fixtures[key(route.request())];
    if(!entry){errors.push(phase+': uncaptured replay request '+JSON.stringify(id));await route.abort('failed');return;}
    assert.deepEqual(entry.identity,id,'replay fixture identity');validate(entry);
    await route.fulfill({status:entry.status,json:entry.data});
  });
}
const sessions=new WeakMap();
async function touch(p,points,type){
  let session=sessions.get(p);
  if(!session){session=await p.context().newCDPSession(p);sessions.set(p,session);}
  await session.send('Input.dispatchTouchEvent',{type,touchPoints:points});

}
async function settled(p){
  await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await p.waitForFunction(()=>!document.querySelector('.right-panel')?.getAnimations().some(a=>a.playState==='running'),null,{timeout:5000});
}
async function closePanel(p){
  if(await p.locator('.right-panel.mobile-visible').count())await p.getByRole('button',{name:'Close details panel'}).click();
  await p.locator('.right-panel.mobile-visible').waitFor({state:'detached'});
  await settled(p);
}
async function center(locator){
  const p=locator.page();await settled(p);
  let previous=null,stable=0;
  for(let attempt=0;attempt<100;attempt++){
    const point=await locator.evaluate(el=>{
      const r=el.getBoundingClientRect();
      for(const fy of [.5,.75,.25,.9,.1])for(const fx of [.5,.75,.25,.9,.1]){
        const x=r.left+r.width*fx,y=r.top+r.height*fy,hit=document.elementFromPoint(x,y);
        if(hit&&(hit===el||el.contains(hit)))return{x,y,id:1};
      }
      return null;
    }).catch(()=>null);
    stable=point&&previous&&Math.hypot(point.x-previous.x,point.y-previous.y)<2?stable+1:0;
    if(stable>=2)return point;
    // Full labels can place nodes outside a short landscape viewport at 1x.
    // Use the real Fit control before attempting a hold; never force-click.
    if(attempt===30&&!point&&(await locator.getAttribute('aria-label')).startsWith('Open file: ')){
      await p.getByRole('button',{name:'Fit view',exact:true}).click();
      await pause(500);
    }
    previous=point;await pause(50);
  }
  throw new Error('settled target has no stable reachable hit area: '+await locator.getAttribute('aria-label'));
}
async function selectable(p,locator){
  // Real drag produces a browser Selection; copy-event payload verifies it.
  await locator.scrollIntoViewIfNeeded();
  const b=await locator.boundingBox();
  await p.mouse.move(b.x+2,b.y+b.height/2);await p.mouse.down();
  await p.mouse.move(b.x+Math.min(b.width-2,200),b.y+b.height/2,{steps:12});await p.mouse.up();
  const selected=await p.evaluate(()=>getSelection().toString());
  assert.ok(selected.trim().length>3,'actual text selection');
  const copied=await p.evaluate(()=>{
    let copied='';const listener=e=>{copied=getSelection().toString();e.preventDefault();};
    document.addEventListener('copy',listener,{once:true});document.execCommand('copy');return copied;
  });
  assert.equal(copied,selected,'copy event preserves selected text');
}
for(const viewport of [{width:390,height:844},{width:844,height:390}]){
  await check('touch emulation '+viewport.width+'x'+viewport.height,async()=>{
    const context=await browser.newContext({viewport,hasTouch:true,isMobile:true});
    const p=await context.newPage();watch(p);await replay(p);await load(p);
    await closePanel(p);
    const graph=p.locator('svg').filter({has:fileNode(p)}).first();
    await graph.evaluate(async svg=>{
      const start=performance.now();let prior=[],stable=0;
      while(performance.now()-start<12000){
        const positions=[...svg.querySelectorAll('.graph-interactive-node')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y];});
        stable=positions.length===prior.length&&positions.every((p,i)=>Math.hypot(p[0]-prior[i][0],p[1]-prior[i][1])<.3)?stable+1:0;
        if(stable>=8)return;prior=positions;await new Promise(requestAnimationFrame);
      }
      throw new Error('repository graph did not settle before background gesture');
    });
    const blanks=await graph.evaluate(svg=>{
      const r=svg.getBoundingClientRect(),found=[];
      for(let y=Math.max(r.top+40,40);y<Math.min(r.bottom-80,innerHeight-100);y+=25){
        const row=[];
        for(let x=Math.max(r.left+30,30);x<Math.min(r.right-30,innerWidth-30);x+=25){
          const e=document.elementFromPoint(x,y);
          if(e===svg)row.push({x,y});
        }
        if(row.length>4){found.push(row[0],row.at(-1));break;}
      }
      return found;
    });
    assert.equal(blanks.length,2,'two reachable graph background points');
    let a={...blanks[0],id:1},b={...blanks[1],id:2};
    const zoomBefore=await graph.evaluate(e=>({x:e.__zoom.x,y:e.__zoom.y,k:e.__zoom.k}));
    await touch(p,[a],'touchStart');await pause(100);
    for(let i=1;i<=4;i++){await touch(p,[{...a,x:a.x+10*i,y:a.y+5*i}],'touchMove');await pause(80);}
    await touch(p,[],'touchEnd');await pause(100);
    const panAfter=await graph.evaluate(e=>({x:e.__zoom.x,y:e.__zoom.y}));
    console.log('  pan '+JSON.stringify({zoomBefore,panAfter}));
    assert.ok(panAfter.x!==zoomBefore.x||panAfter.y!==zoomBefore.y,'touch background pan');
    await touch(p,[a,b],'touchStart');await pause(100);
    for(let i=1;i<=4;i++){await touch(p,[{...a,x:a.x+5*i},{...b,x:b.x-5*i}],'touchMove');await pause(80);}
    await touch(p,[],'touchEnd');await pause(100);
    assert.notEqual(await graph.evaluate(e=>e.__zoom.k),zoomBefore.k,'graph pinch zoom');
    assert.equal(await p.evaluate(()=>visualViewport.scale),1);
    await p.getByRole('button',{name:'Reset zoom',exact:true}).click();await pause(600);
        let target=fileNode(p),point=await center(target);
    const count=()=>requests.filter(r=>r.phase===phase&&r.url==='/api/graph/file').length;
    const before=count();
    // Cancelled hold via meaningful drag.
    await touch(p,[point],'touchStart');await pause(150);
    await touch(p,[{...point,x:point.x+45,y:point.y+25}],'touchMove');await pause(750);
    await touch(p,[],'touchEnd');assert.equal(count(),before);
    await pause(600);
    // Releasing early selects normally, without drilling down.
    point=await center(target);
    await touch(p,[point],'touchStart');await pause(120);await touch(p,[],'touchEnd');
    await p.locator('.right-panel.mobile-visible').waitFor();
    assert.equal(count(),before);
    await p.getByRole('button',{name:'View Source',exact:true}).click();await p.locator('.file-preview-code').waitFor();
    await selectable(p,p.locator('.file-preview-line').nth(1).locator('span').last());
    await p.locator('.file-preview-close').click();await closePanel(p);
        // Pinch / multi-touch, then cancellation.
    point=await center(target);
    await touch(p,[point],'touchStart');
    await touch(p,[point,{...point,id:2,x:point.x+70}],'touchStart');
    await touch(p,[{...point,x:point.x-20},{...point,id:2,x:point.x+100}],'touchMove');
    await pause(750);await touch(p,[],'touchCancel');assert.equal(count(),before);
    assert.equal(await p.evaluate(()=>visualViewport.scale),1,'pinch must not zoom the browser page');
    // Pointer cancellation alone, navigation and orientation interrupt holds.
    point=await center(target);await touch(p,[point],'touchStart');await pause(150);await touch(p,[],'touchCancel');await pause(700);assert.equal(count(),before);
    point=await center(target);await touch(p,[point],'touchStart');await pause(150);
    await p.evaluate(()=>document.dispatchEvent(new Event('codeflow:navigation')));await pause(700);await touch(p,[],'touchEnd');assert.equal(count(),before);await closePanel(p);
    point=await center(target);await touch(p,[point],'touchStart');await pause(150);
    await p.setViewportSize({width:viewport.height,height:viewport.width});await touch(p,[],'touchCancel');await pause(700);assert.equal(count(),before);
    await p.setViewportSize(viewport);await closePanel(p);
    // Long hold with observable progress.
    point=await center(target);
    await touch(p,[point],'touchStart');await pause(250);
    assert.equal(await target.getAttribute('data-holding'),'true');
    await p.screenshot({path:join(out,'hold-'+viewport.width+'.png')});
    await pause(1800);await touch(p,[],'touchEnd');await fileReady(p);
    assert.equal(count(),before+1);
    // No blanket post-hold sleep: fresh Close and Open inputs must work now.
    await closePanel(p);await p.getByRole('button',{name:'Open insights panel'}).click();await settled(p);
    await selectable(p,p.locator('.card > .panel-title').filter({hasText:PATH}).first());
    await p.screenshot({path:join(out,'inspector-selection-'+p.viewportSize().width+'.png')});
    
    // Explicit fallback is reachable in the Inspector; unsupported module is disabled.
    const choose=p.getByRole('combobox',{name:'Function to open'});
    await choose.selectOption({index:1});
    const selected=await choose.inputValue();
    const disabled=await p.getByRole('button',{name:'Open function',exact:true}).isDisabled();
    console.log('  first symbol='+selected+' disabled='+disabled);assert.equal(disabled,true);
    await fnNode(p).click();
    assert.ok(await p.locator('svg[aria-label="File symbols"] g[opacity="0.15"]').count());
    await p.locator('svg[aria-label="File symbols"]').click({position:{x:3,y:3}});
    assert.equal(await p.locator('svg[aria-label="File symbols"] g[opacity="0.15"]').count(),0);
    assert.equal(await choose.inputValue(),'');
        await choose.selectOption({label:'SessionRedirectMixin.resolve_redirects'});
    assert.equal(await p.getByRole('button',{name:'Open function',exact:true}).isEnabled(),true);
    await choose.scrollIntoViewIfNeeded();
    target=fnNode(p);await target.scrollIntoViewIfNeeded();await pause(300);
    point=await center(target);
    const fbefore=requests.filter(r=>r.phase===phase&&r.url==='/api/graph/function').length;
    // A real Back action during an active file-node hold cancels navigation.
    await touch(p,[point],'touchStart');await pause(150);await back(p).click();await touch(p,[],'touchCancel');
    await closePanel(p);await pause(700);assert.equal(requests.filter(r=>r.phase===phase&&r.url==='/api/graph/function').length,fbefore);
    const reopenPoint=await center(fileNode(p));await p.mouse.click(reopenPoint.x,reopenPoint.y);
    await p.getByRole('button',{name:'Open file',exact:true}).click();await fileReady(p);
    target=fnNode(p);await target.scrollIntoViewIfNeeded();point=await center(target);
    await touch(p,[point],'touchStart');await pause(750);await touch(p,[],'touchEnd');await fnReady(p);
    assert.equal(requests.filter(r=>r.phase===phase&&r.url==='/api/graph/function').length,fbefore+1);
    await p.screenshot({path:join(out,'function-'+viewport.width+'.png')});
    await back(p).click();await fileReady(p);
    await closePanel(p);
    await p.getByRole('button',{name:'Open insights panel'}).click();await settled(p);
    await openSelected(p);
    await back(p).click();await fileReady(p);await back(p).click();
    await closePanel(p);const repoPoint=await center(fileNode(p));await p.mouse.click(repoPoint.x,repoPoint.y);
    const explicit=p.getByRole('button',{name:'Open file',exact:true});await explicit.focus();
    assert.ok(await explicit.evaluate(e=>document.activeElement===e));await explicit.press('Space');await fileReady(p);
    await openSelected(p);await back(p).click();await fileReady(p);await back(p).click();
    await context.close();
  });
}
await check('desktop node keyboard activation and Inspector copy',async()=>{
  const p=await browser.newPage({viewport:{width:1680,height:1000}});watch(p);await replay(p);await load(p);
  await fileNode(p).focus();assert.ok(await fileNode(p).evaluate(e=>e===document.activeElement));await fileNode(p).press('Space');await fileReady(p);
  await selectable(p,p.locator('.card > .panel-title').filter({hasText:PATH}).first());
  await fnNode(p).focus();await fnNode(p).press('Enter');await fnReady(p);
  await back(p).click();await fileReady(p);await back(p).click();
});
await check('interrupted latest file navigation and repeated Back',async()=>{
  const p=await browser.newPage({viewport:{width:1680,height:1000}});watch(p);await replay(p);await load(p);
  await p.route('**/api/graph/file',async route=>{
    if(route.request().postDataJSON().path===PATH){
      await pause(700);
      const entry=fixtures[key(route.request())];
      if(!entry){errors.push(phase+': uncaptured delayed replay '+key(route.request()));await route.abort().catch(()=>{});return;}
      validate(entry);await route.fulfill({json:entry.data}).catch(()=>{});
    }else await route.fallback();
  });
  const first=p.waitForRequest(r=>r.url().endsWith('/api/graph/file'));
  await fileNode(p).dblclick();await first;
  await p.getByRole('button',{name:'Open file: src/requests/models.py',exact:true}).dblclick();
  await p.locator('.card > .panel-title').filter({hasText:'src/requests/models.py'}).waitFor();
  await fileReady(p);await pause(1000);
  assert.equal(await p.locator('.card > .panel-title').filter({hasText:PATH}).count(),0);
  await back(p).click();
  await fileNode(p).dblclick();await fileReady(p);
  await openSelected(p);await back(p).click();await fileReady(p);await back(p).click();
  await p.close();
});
await check('ordinary metadata errors, synchronous failure, stale selection and preview dismissal',async()=>{
  const p=await browser.newPage({viewport:{width:1680,height:1000}});watch(p);await replay(p);await load(p);
  expectHttpError=true;
  await p.route('**/api/github/blame',route=>route.fulfill({status:502,json:{error:'Controlled ownership request error'}}));
  await fileNode(p).click();
  await p.locator('.card-header').filter({hasText:'Ownership'}).click();
  await p.getByRole('status').filter({hasText:'Controlled ownership request error'}).waitFor();
  assert.equal(await p.locator('.loading-owner').count(),0);
  await p.route('**/api/github/file-content',route=>route.fulfill({status:502,json:{error:'Controlled preview request error'}}));
  await p.getByRole('button',{name:'View Source',exact:true}).click();
  await p.locator('.file-preview-error').filter({hasText:'Controlled preview request error'}).waitFor();
  await p.locator('.file-preview-close').click();
  await p.evaluate(()=>{window.fetchBlame=()=>{throw new Error('Controlled synchronous ownership error');};window.fetchFileContentFromServer=()=>{throw new Error('Controlled synchronous preview error');};});
  await fileNode(p).click();
  // Re-select another file first because selecting the same object does not rerun an effect.
  const other=p.getByRole('button',{name:'Open file: src/requests/models.py',exact:true});
  await other.click();await fileNode(p).click();
  await p.getByRole('status').filter({hasText:'Controlled synchronous ownership error'}).waitFor();
  await p.getByRole('button',{name:'View Source',exact:true}).click();
  await p.locator('.file-preview-error').filter({hasText:'Controlled synchronous preview error'}).waitFor();
  await p.locator('.file-preview-close').click();
  await p.evaluate(()=>{
    window.fetchBlame=({path})=>new Promise(resolve=>setTimeout(()=>resolve([{name:path,commits:1,percent:100}]),path.endsWith('sessions.py')?600:20));
    window.fetchFileContentFromServer=()=>new Promise(resolve=>setTimeout(()=>resolve('late source'),600));
  });
  await other.click();await fileNode(p).click();await other.click();await pause(800);
  assert.deepEqual(await p.locator('.owner-name').allTextContents(),['src/requests/models.py']);
  await p.getByRole('button',{name:'View Source',exact:true}).click();await p.locator('.file-preview-close').click();
  await pause(800);assert.equal(await p.locator('.file-preview-overlay').count(),0);
  await p.screenshot({path:join(out,'metadata-error-check.png')});
  await p.close();expectHttpError=false;
});
await check('local repository without revision disables Open file fallback',async()=>{
  const p=await browser.newPage({viewport:{width:1680,height:1000}});watch(p);
  await p.goto(base);
  await p.locator('input[webkitdirectory]').setInputFiles(new URL('./fixtures/python-symbols/',import.meta.url).pathname.replace(/^\/(C:)/,'$1'));
  const node=p.getByRole('button',{name:/^Select file: /}).first();
  await node.waitFor({timeout:30000});
  assert.equal(await node.getAttribute('aria-disabled'),'false');
  await node.focus();await node.press('Enter');
  const before=requests.filter(r=>r.phase===phase&&r.url==='/api/graph/file').length;
  const point=await center(node);await p.mouse.click(point.x,point.y);
  assert.equal(await p.getByRole('button',{name:'Open file',exact:true}).isDisabled(),true);
  await p.getByText(/No GitHub revision context is available/).waitFor();
  assert.equal(requests.filter(r=>r.phase===phase&&r.url==='/api/graph/file').length,before);
  await p.close();
});
await check('controlled fatal boundary renders neutral UI',async()=>{
  const p=await browser.newPage();watch(p);expectFatal=true;
  await p.route(base,async route=>{
    const response=await route.fetch();let html=await response.text();
    assert.ok(html.includes('function App(){'));
    html=html.replace('function App(){',"function App(){throw new Error('Controlled local boundary test');");
    await route.fulfill({response,body:html});
  });
  await p.goto(base);
  await p.getByText(/^An unexpected error prevented CodeFlow from continuing\./).waitFor();
  assert.equal(await p.getByText(/available memory/).count(),0);
  await p.screenshot({path:join(out,'fatal-neutral.png')});
  await p.close();expectFatal=false;
});
await writeFile(join(out,'results.json'),JSON.stringify({browser:browser.version(),platform:process.platform,results,errors,requests,captures,mode:replayOnly?'captured replay + fault injection':'live capture + captured replay + fault injection',realDevices:'UNRUN: no iOS/Android device browser accessed'},null,2));
await browser.close();
assert.deepEqual(errors,[],'Unexpected console/page errors');
assert.ok(results.every(r=>r.status==='PASS'),'One or more checks failed');
