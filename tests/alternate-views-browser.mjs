// Five alternate views, using an unchanged captured real repository response.
// Run against the production local app (not Vite): node tests/alternate-views-browser.mjs [base] [out] [fixture]
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const [base='http://127.0.0.1:4334/',out='test-results/alternate-views',fixturePath='test-results/final/simbrain-cold.json']=process.argv.slice(2);
assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname),'Local app only');
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const workingTree=execFileSync('git',['status','--short'],{encoding:'utf8'}).trim();
const bytes=await readFile(fixturePath),fixture=JSON.parse(bytes),context=fixture.graph.context;
const files=fixture.graph.nodes.filter(n=>n.kind==='file'&&n.coordinate?.path).map(n=>({
  id:n.id,path:n.coordinate.path,name:n.coordinate.path.split('/').at(-1),
  folder:n.coordinate.path.split('/').slice(0,-1).join('/')||'root',
}));
const oracle=Object.fromEntries(files.map(f=>[f.path,f.name]));
const folders={};for(const f of files)folders[f.folder]=(folders[f.folder]||0)+1;
const idToPath=new Map(files.map(f=>[f.id,f.path]));
const connectionPairs=new Set(fixture.graph.edges.filter(e=>idToPath.has(e.source)&&idToPath.has(e.target))
  .map(e=>idToPath.get(e.source)+'\0'+idToPath.get(e.target)));
const paths=files.map(f=>f.path).sort(),folderPaths=Object.keys(folders).sort();
assert.ok(paths.length>0);
const specs=[
  {id:'matrix',labels:'text.row-label,text.col-label'},
  {id:'dendro',labels:'g.dendro-node text'},
  {id:'sankey',labels:'g.sankey-node text,text.sankey-folder-fallback'},
  {id:'disjoint',labels:'text.disjoint-label,text.cluster-label'},
  {id:'bundle',labels:'g.bundle-node text,text.bundle-folder-label'},
];
await mkdir(out,{recursive:true});
const result={commit,workingTree,base,fixturePath,fixtureSha256:createHash('sha256').update(bytes).digest('hex'),
  mode:'full captured repository response replay; metadata uses actual local server; font-event injection explicitly controlled',
  oracle:'coordinate.path supplies full filenames/folders independently of rendered text',
  context,sourceFileCount:files.length,sourceFolderCount:folderPaths.length,uniqueSourceConnections:connectionPairs.size,
  limitations:['Chromium emulation only','3D and architecture remain separate baseline gaps','Flow cycle fallback is not a successful Sankey diagram',
    'no claim of exhaustive edge routing or geometry outside measured Cluster node bounds'],views:[]};
const browser=await chromium.launch();
try{
for(const spec of specs){
  const entry={view:spec.id,checks:[],errors:[],requests:[]};result.views.push(entry);
  const page=await browser.newPage({viewport:{width:1680,height:1000}});
  page.setDefaultTimeout(20000);
  page.on('pageerror',e=>entry.errors.push({kind:'pageerror',message:e.message}));
  page.on('console',m=>{if(m.type()==='error')entry.errors.push({kind:'console',message:m.text()});});
  page.on('request',r=>{
    if(!new URL(r.url()).pathname.startsWith('/api/'))return;
    entry.requests.push({endpoint:new URL(r.url()).pathname,body:r.postData()?r.postDataJSON():null,authorizationPresent:!!r.headers().authorization});
  });
  await page.addInitScript(()=>{
    const track=window.__altLifetime={capture:false,fonts:new Set(),observers:new Set()};
    const add=document.fonts.addEventListener.bind(document.fonts),remove=document.fonts.removeEventListener.bind(document.fonts);
    document.fonts.addEventListener=function(type,listener,...rest){if(type==='loadingdone'&&track.capture)track.fonts.add(listener);return add(type,listener,...rest);};
    document.fonts.removeEventListener=function(type,listener,...rest){if(type==='loadingdone')track.fonts.delete(listener);return remove(type,listener,...rest);};
    const Native=window.ResizeObserver;
    window.ResizeObserver=class extends Native{
      observe(target,...rest){if(target.matches?.('.matrix-container,.dendro-container,.sankey-container,.disjoint-container,.bundle-container'))track.observers.add(this);return super.observe(target,...rest);}
      disconnect(){track.observers.delete(this);return super.disconnect();}
    };
  });
  await page.route('**/api/graph/repository',async route=>{
    const body=route.request().postDataJSON();
    try{
      assert.equal(body.owner,context.owner);assert.equal(body.repo,context.repo);assert.equal(body.ref,context.resolvedSha);
      await route.fulfill({status:200,contentType:'application/json',body:bytes});
    }catch(e){entry.errors.push({kind:'replay',message:e.message});await route.abort();}
  });
  const host=()=>page.locator('.'+spec.id+'-container');
  async function settle(){
    if(spec.id!=='disjoint')return;
    await page.evaluate(()=>{window.__clusterStable=null;});
    await page.waitForFunction(()=>{
      const nodes=[...document.querySelectorAll('.disjoint-node')];
      if(!nodes.length)return false;
      const signature=nodes.map(n=>n.getAttribute('transform')).join('|'),now=performance.now();
      const prior=window.__clusterStable;
      if(!prior||signature!==prior.signature){window.__clusterStable={signature,since:now};return false;}
      return now-prior.since>=1000;
    },null,{timeout:60000,polling:150});
  }
  async function snapshot(){
    return host().evaluate((root,{spec,oracle,folders})=>{
      const labels=[...root.querySelectorAll(spec.labels)].map(t=>{
        const d=t.__data__;
        // D3 hierarchy nodes have an inherited path() METHOD. It is not a source path.
        const candidate=d?.data?.path??(typeof d?.path==='string'?d.path:null)??(typeof d?.id==='string'?d.id:null);
        const path=typeof candidate==='string'&&Object.hasOwn(oracle,candidate)?candidate:null;
        const folderCandidate=d?.data?.fullPath??d?.fullPath??(typeof d==='string'?d:Array.isArray(d)?d[0]:null);
        const folder=typeof folderCandidate==='string'&&Object.hasOwn(folders,folderCandidate)?folderCandidate:null;
        const expected=path?oracle[path]:folder?folder+(spec.id==='sankey'?' ('+folders[folder]+')':''):null;
        return {path,folder,actual:t.textContent,expected,opacity:Number(getComputedStyle(t).opacity)};
      });
      return {labels,cellCount:root.querySelectorAll('.matrix-cell-rect').length,
        rows:root.querySelectorAll('.row-label').length,columns:root.querySelectorAll('.col-label').length,
        fallback:root.querySelector('[role="status"]')?.textContent||null};
    },{spec,oracle,folders});
  }
  async function fitCheck(label){
    await host().getByRole('button',{name:'Fit complete view',exact:true}).click();
    const bounds=await host().evaluate(root=>{
      const svg=root.querySelector('svg'),group=svg.querySelector('g'),s=svg.getBoundingClientRect(),b=group.getBoundingClientRect();
      return {scale:svg.__zoom.k,left:b.left-s.left,top:b.top-s.top,right:s.right-b.right,bottom:s.bottom-b.bottom};
    });
    assert.ok(Object.values(bounds).every(Number.isFinite),label+': finite bounds');
    assert.ok(bounds.left>=-2&&bounds.top>=-2&&bounds.right>=-2&&bounds.bottom>=-2,label+': complete content inside SVG '+JSON.stringify(bounds));
    entry.checks.push({name:label,bounds});
  }
  try{
    const documentResponse=await page.goto(base,{waitUntil:'domcontentloaded'});
    entry.documentSha256=createHash('sha256').update(await documentResponse.body()).digest('hex');
    await page.waitForFunction(()=>typeof window.fetchRepositoryGraph==='function');
    await page.evaluate(ref=>{const original=window.fetchRepositoryGraph;window.fetchRepositoryGraph=input=>original({...input,ref});},context.resolvedSha);
    const input=page.getByRole('textbox',{name:'Repository URL',exact:true}).first();
    await input.fill(context.owner+'/'+context.repo);await input.press('Enter');
    await page.getByTestId('revision-badge').waitFor({state:'attached',timeout:120000});
    await page.evaluate(()=>{window.__altLifetime.capture=true;});
    await page.getByRole('combobox',{name:'Visualization type',exact:true}).selectOption(spec.id);
    await host().locator('svg').waitFor();await host().getByRole('button',{name:'Readable labels',exact:true}).waitFor();
    await page.evaluate(()=>document.fonts.ready);await settle();
    const initial=await snapshot();
    assert.equal(initial.labels.filter(l=>l.expected===null).length,0,'every label has an independent source oracle');
    assert.deepEqual(initial.labels.filter(l=>l.actual!==l.expected),[],'complete labels match source oracle');
    if(spec.id==='sankey'){
      assert.deepEqual([...new Set(initial.labels.map(l=>l.folder))].sort(),folderPaths,'all folders represented');
      entry.diagramStatus=initial.fallback?'UNSUPPORTED_WITH_COMPLETE_FOLDER_LIST':'RENDERED';
      entry.fallback=initial.fallback;
      if(initial.fallback)assert.match(initial.fallback,/No cross-folder dependencies|circular references/);
    }else{
      assert.deepEqual([...new Set(initial.labels.filter(l=>l.path).map(l=>l.path))].sort(),paths,'all source file paths represented');
      if(spec.id==='matrix'){
        assert.equal(initial.rows,files.length);assert.equal(initial.columns,files.length);
        assert.ok(initial.cellCount<=connectionPairs.size,'sparse matrix cells bounded by unique source connections');
        entry.sparseMatrix={cells:initial.cellCount,uniqueConnections:connectionPairs.size,quadraticCells:files.length**2};
      }else assert.deepEqual([...new Set(initial.labels.filter(l=>l.folder).map(l=>l.folder))].sort(),folderPaths,'all full folder labels represented');
    }
    entry.checks.push({name:'source completeness',fileLabels:initial.labels.filter(l=>l.path).length,folderLabels:initial.labels.filter(l=>l.folder).length});
    await fitCheck('initial complete fit');
    // Real wheel input exercises overview hiding, not an injected zoom callback.
    await host().getByRole('button',{name:'Readable labels',exact:true}).click();
    const svg=host().locator('svg'),box=await svg.boundingBox();
    await page.mouse.move(box.x+box.width*.55,box.y+box.height*.6);await page.mouse.wheel(0,1600);
    await page.waitForFunction(sel=>document.querySelector(sel+' svg').__zoom.k<.45,'.'+spec.id+'-container');
    assert.ok((await snapshot()).labels.every(l=>l.opacity===0),'overview hides whole labels');
    await host().getByRole('button',{name:'Readable labels',exact:true}).click();
    assert.ok((await snapshot()).labels.every(l=>l.opacity===1),'readable view restores every complete label');
    entry.checks.push({name:'wheel overview and readable restoration',status:'PASS'});
    await page.setViewportSize({width:1100,height:850});
    await page.evaluate(()=>document.fonts.dispatchEvent(new Event('loadingdone')));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await settle();
    assert.deepEqual((await snapshot()).labels.map(l=>[l.path,l.folder,l.actual]),initial.labels.map(l=>[l.path,l.folder,l.actual]),'resize/font remeasure preserves all labels');
    await fitCheck('resize and controlled font remeasure fit');
    if(spec.id==='disjoint'){
      entry.cluster=await host().evaluate(root=>{
        const nodes=[...root.querySelectorAll('.disjoint-node')].map(el=>{
          const b=el.getBBox(),d=el.__data__;return{id:d.id,x:d.x+b.x,y:d.y+b.y,w:b.width,h:b.height};
        }).sort((a,b)=>a.x-b.x);
        const overlaps=[];
        for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length&&nodes[j].x<nodes[i].x+nodes[i].w-.1;j++){
          const a=nodes[i],b=nodes[j];
          if(a.y<b.y+b.h-.1&&a.y+a.h>b.y+.1)overlaps.push([a.id,b.id]);
        }
        return {nodes:nodes.length,overlapCount:overlaps.length,examples:overlaps.slice(0,20)};
      });
      assert.equal(entry.cluster.overlapCount,0,'settled measured Cluster node bounds do not overlap');
    }
    // Focus an overview-hidden label through actual keyboard controls.
    const targetPath=spec.id==='sankey'?folderPaths.find(f=>f!=='root'):files.slice().sort((a,b)=>b.name.length-a.name.length)[0].path;
    const target=host().getByRole('button',{name:(spec.id==='sankey'?'Filter folder: ':'Select file: ')+targetPath,exact:true}).first();
    await target.focus();
    assert.equal(await target.evaluate(e=>document.activeElement===e),true);
    assert.equal(await svg.evaluate(e=>e.__zoom.k),1,'focus reveals a readable scale');
    assert.ok((await snapshot()).labels.every(l=>l.opacity===1),'focus restores label opacity');
    const visibleTarget=await target.evaluate(e=>{
      const a=e.getBoundingClientRect(),b=e.ownerSVGElement.getBoundingClientRect();
      return a.right>b.left&&a.left<b.right&&a.bottom>b.top&&a.top<b.bottom;
    });
    assert.ok(visibleTarget,'focused source target is in the viewport');
    await page.screenshot({path:join(out,spec.id+'-readable.png')});
    await target.press('Enter');
    if(spec.id==='sankey'){
      const expectedFolders=folderPaths.filter(f=>f===targetPath||f.startsWith(targetPath+'/'));
      await page.waitForFunction(({selector,expected})=>{
        const root=document.querySelector(selector);
        return root&&root.querySelectorAll('.sankey-node text,.sankey-folder-fallback').length===expected;
      },{selector:'.sankey-container',expected:expectedFolders.length});
      assert.deepEqual([...new Set((await snapshot()).labels.map(l=>l.folder))].sort(),expectedFolders,'keyboard folder filter applies');
    }else{
      const selectedSource=files.find(f=>f.path===targetPath);
      await page.waitForFunction(({name,folder})=>
        [...document.querySelectorAll('.right-panel .panel-header')].some(header=>
          header.querySelector('.panel-title')?.textContent.trim()===name&&
          header.querySelector('.panel-subtitle')?.textContent.startsWith(folder+' • ')),
        {name:selectedSource.name,folder:selectedSource.folder});
      entry.inspectorOracle={path:targetPath,name:selectedSource.name,folder:selectedSource.folder};
    }
    entry.checks.push({name:'keyboard focus reveal and selection',targetPath,status:'PASS'});
    if(spec.id==='matrix'){
      // Pointer focus must not recenter an already reachable label between
      // mousedown and click. Start with a different, previously unfocused
      // off-center column label; do not pre-focus it or dispatch fake events.
      const candidate=await host().locator('text.col-label').evaluateAll(elements=>{
        const bounds=elements[0].ownerSVGElement.getBoundingClientRect();
        for(const el of elements){
          const rect=el.getBoundingClientRect();
          const offCenter=Math.abs((rect.left+rect.right)/2-(bounds.left+bounds.right)/2);
          if(el!==document.activeElement&&Number(getComputedStyle(el).opacity)===1&&
              rect.left>bounds.left+10&&rect.right<bounds.right-10&&
              rect.top>bounds.top+100&&rect.bottom<bounds.bottom-10&&offCenter>40)
            return {path:el.__data__.path,offCenter};
        }
        return null;
      });
      assert.ok(candidate,'an unfocused off-center column label is fully reachable');
      const pointerTarget=host().getByRole('button',{name:'Select file: '+candidate.path,exact:true})
        .and(host().locator('text.col-label'));
      assert.equal(await pointerTarget.evaluate(el=>el===document.activeElement),false,'ordinary click target is not already focused');
      const before=await svg.evaluate(el=>({x:el.__zoom.x,y:el.__zoom.y,k:el.__zoom.k}));
      await pointerTarget.click();
      const after=await svg.evaluate(el=>({x:el.__zoom.x,y:el.__zoom.y,k:el.__zoom.k}));
      entry.pointerClick={candidate,before,after};
      assert.deepEqual(after,before,'ordinary pointer focus must preserve the viewport during click');
      const selectedSource=files.find(f=>f.path===candidate.path);
      assert.ok(selectedSource,'clicked identity exists in source-coordinate oracle');
      await page.waitForFunction(({name,folder})=>
        [...document.querySelectorAll('.right-panel .panel-header')].some(header=>
          header.querySelector('.panel-title')?.textContent.trim()===name&&
          header.querySelector('.panel-subtitle')?.textContent.startsWith(folder+' • ')),
        {name:selectedSource.name,folder:selectedSource.folder});
      const afterSelection=await svg.evaluate(el=>({x:el.__zoom.x,y:el.__zoom.y,k:el.__zoom.k}));
      assert.deepEqual(afterSelection,before,'pointer selection must not recenter the viewport');
      entry.pointerClick.inspectorOracle={path:selectedSource.path,name:selectedSource.name,folder:selectedSource.folder};
      entry.pointerClick.afterSelection=afterSelection;
      await page.screenshot({path:join(out,'matrix-pointer-selection.png')});
      entry.checks.push({name:'ordinary off-center pointer click preserves viewport and selects source',status:'PASS'});
      // Inspect the same source selected by the ordinary click. Name + full
      // folder reconstruct the independent coordinate.path; neither may clip.
      // The repository is replayed, but View Source uses the real local API.
      entry.inspectorLayouts=[];
      for(const width of [1100,390]){
        await page.setViewportSize({width,height:850});
        if(width===390){
          await page.getByRole('button',{name:'Open insights panel',exact:true}).click();
          await page.locator('.right-panel.mobile-visible').waitFor();
          const mobileHeader=page.locator('.right-panel .mobile-panel-header');
          const mobile=await mobileHeader.evaluate(header=>{
            const rect=r=>({left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height});
            const parts=['.mobile-panel-title','.mobile-panel-subtitle'].map(selector=>{
              const el=header.querySelector(selector),style=getComputedStyle(el);
              const range=document.createRange();range.selectNodeContents(el);
              return {selector,text:el.textContent,rect:rect(el.getBoundingClientRect()),
                fragments:[...range.getClientRects()].map(rect),
                scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,
                scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,
                whiteSpace:style.whiteSpace,textOverflow:style.textOverflow,overflowWrap:style.overflowWrap};
            });
            return {parts,panel:rect(header.closest('.right-panel').getBoundingClientRect()),
              close:rect(header.querySelector('[aria-label="Close details panel"]').getBoundingClientRect())};
          });
          entry.mobileHeader=mobile;
          assert.equal(mobile.parts[0].text,selectedSource.name,'mobile header preserves full oracle filename');
          assert.equal(mobile.parts[1].text,selectedSource.path,'mobile header preserves full oracle source path');
          const inside=(r,b)=>r.left>=b.left-1&&r.right<=b.right+1&&r.top>=b.top-1&&r.bottom<=b.bottom+1;
          const visiblePanel={left:Math.max(0,mobile.panel.left),right:Math.min(390,mobile.panel.right),
            top:Math.max(0,mobile.panel.top),bottom:Math.min(850,mobile.panel.bottom)};
          for(const part of mobile.parts){
            assert.ok(part.rect.width>0&&part.rect.height>0,part.selector+' has visible dimensions');
            assert.ok(inside(part.rect,visiblePanel),part.selector+' stays inside the mobile Inspector and viewport');
            assert.ok(part.scrollWidth<=part.clientWidth+1&&part.scrollHeight<=part.clientHeight+1,
              part.selector+' renders complete text without clipping');
            assert.notEqual(part.whiteSpace,'nowrap',part.selector+' allows long source identity to wrap');
            assert.notEqual(part.textOverflow,'ellipsis',part.selector+' does not abbreviate source identity');
            assert.ok(part.fragments.length>0&&part.fragments.every(r=>inside(r,part.rect)&&inside(r,visiblePanel)),
              part.selector+' renders every text fragment inside its visible bounds');
            assert.ok(part.rect.right<=mobile.close.left+1,part.selector+' leaves a separate slot for Close');
          }
          assert.ok(mobile.close.width>0&&mobile.close.height>0&&inside(mobile.close,visiblePanel),
            'mobile Close remains inside the Inspector and viewport');
          await mobileHeader.getByRole('button',{name:'Close details panel',exact:true}).click({trial:true});
          await page.screenshot({path:join(out,'matrix-mobile-header-390.png')});
          entry.checks.push({name:'mobile duplicate filename/path complete and Close reachable',width,path:selectedSource.path,status:'PASS'});
        }
        const header=page.getByTestId('selected-file-header');
        await header.waitFor();
        await header.scrollIntoViewIfNeeded();
        const layout=await header.evaluate(el=>{
          const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
          const title=el.querySelector('.panel-title'),subtitle=el.querySelector('.panel-subtitle');
          const parts=[
            ['name',title],['folder and metadata',subtitle],
            ['Open file',el.querySelector('[aria-describedby="file-open-help"]')],
            ['Open help',el.querySelector('#file-open-help')],
            ['View Source',el.querySelector('.view-file-btn')],
          ].map(([name,node])=>({
            name,text:node.textContent.trim(),rect:rect(node),
            scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,
            scrollHeight:node.scrollHeight,clientHeight:node.clientHeight,
            textOverflow:getComputedStyle(node).textOverflow,
          }));
          return {viewport:{width:innerWidth,height:innerHeight},panel:rect(el.closest('.right-panel')),header:rect(el),parts};
        });
        entry.inspectorLayouts.push(layout);
        assert.equal(layout.parts[0].text,selectedSource.name,'Inspector shows the full oracle filename');
        assert.ok(layout.parts[1].text.startsWith(selectedSource.folder+' • '),'Inspector shows the full oracle folder');
        assert.equal((selectedSource.folder==='root'?'':selectedSource.folder+'/')+layout.parts[0].text,selectedSource.path);
        for(const part of layout.parts){
          const r=part.rect,p=layout.panel;
          assert.ok(r.width>0&&r.height>0,part.name+' has visible dimensions at '+width);
          assert.ok(r.left>=Math.max(0,p.left)-1&&r.right<=Math.min(width,p.right)+1,
            part.name+' stays inside Inspector and viewport horizontally at '+width);
          assert.ok(r.top>=Math.max(0,p.top)-1&&r.bottom<=Math.min(850,p.bottom)+1,
            part.name+' is reachable inside Inspector and viewport vertically at '+width);
          assert.ok(part.scrollWidth<=part.clientWidth+1&&part.scrollHeight<=part.clientHeight+1,
            part.name+' is fully laid out without clipping at '+width);
        }
        await page.screenshot({path:join(out,'matrix-inspector-'+width+'.png')});
        const [response]=await Promise.all([
          page.waitForResponse(r=>new URL(r.url()).pathname==='/api/github/file-content'&&
            r.request().postDataJSON()?.path===selectedSource.path,{timeout:300000}),
          header.getByRole('button',{name:'View Source',exact:true}).click(),
        ]);
        const request=response.request().postDataJSON();
        assert.equal(request.owner,context.owner);assert.equal(request.repo,context.repo);
        assert.equal(request.ref,context.resolvedSha);assert.equal(request.path,selectedSource.path);
        layout.sourceAction={status:response.status(),request,
          mode:'actual local file-content endpoint; server may use cache',
          cacheControl:response.headers()['cache-control']??null};
        assert.equal(response.status(),200,'actual source endpoint succeeds at '+width);
        const source=await response.json();
        assert.equal(typeof source.content,'string','actual endpoint provides source text');
        await page.locator('.file-preview-code').waitFor();
        assert.equal(await page.locator('.file-preview-error').count(),0);
        assert.equal(await page.locator('.file-preview-path').textContent(),selectedSource.path);
        assert.equal(await page.locator('.file-preview-name').textContent(),selectedSource.name);
        assert.deepEqual(await page.locator('.file-preview-text').allTextContents(),source.content.split('\n'),
          'preview text equals actual source response');
        layout.sourceAction.lines=source.content.split('\n').length;
        await page.screenshot({path:join(out,'matrix-source-'+width+'.png')});
        await page.locator('.file-preview-close').click();
        await page.locator('.file-preview-overlay').waitFor({state:'hidden'});
        if(width===390){
          await page.getByRole('button',{name:'Close details panel',exact:true}).click();
          await page.locator('.right-panel.mobile-visible').waitFor({state:'hidden'});
        }
        entry.checks.push({name:'Inspector complete identity, bounded controls and actual source action',width,path:selectedSource.path,status:'PASS'});
      }
      await page.setViewportSize({width:1100,height:850});
    }
    // Switch away, then verify that font/resize events cannot mutate disposed SVG.
    await page.evaluate(selector=>{
      window.__oldAlternateSvg=document.querySelector(selector+' svg');
      window.__altLifetime.capture=false;
    },'.'+spec.id+'-container');
    await page.getByRole('combobox',{name:'Visualization type',exact:true}).selectOption('matrix'===spec.id?'dendro':'matrix');
    await page.locator('.alternate-view-controls').waitFor();
    const disposed=await page.evaluate(()=>{
      const old=window.__oldAlternateSvg;
      window.__oldAlternateHtml=old.outerHTML;
      document.fonts.dispatchEvent(new Event('loadingdone'));
      return {connected:old.isConnected,fonts:window.__altLifetime.fonts.size,
        oldZoomListeners:(old.__on||[]).filter(x=>x.name==='zoom').length,
        // The replacement owns one observer. No previous observer may remain.
        alternateObservers:window.__altLifetime.observers.size};
    });
    assert.equal(disposed.connected,false);assert.equal(disposed.fonts,0);
    assert.equal(disposed.oldZoomListeners,0);assert.equal(disposed.alternateObservers,1);
    await page.setViewportSize({width:1200,height:900});await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>window.__oldAlternateSvg.outerHTML===window.__oldAlternateHtml),true,'disposed SVG remains unchanged');
    entry.checks.push({name:'font/resize/zoom cleanup',...disposed});
    assert.ok(entry.requests.every(r=>!r.authorizationPresent),'no browser Authorization headers');
    assert.deepEqual(entry.errors,[],'unexpected console/page errors');
    entry.status=entry.diagramStatus==='UNSUPPORTED_WITH_COMPLETE_FOLDER_LIST'?'PASS_FOLDER_LIST_DIAGRAM_UNSUPPORTED':'PASS';
  }catch(e){
    entry.status='FAIL';entry.error=e.stack||String(e);
    await page.screenshot({path:join(out,spec.id+'-failure.png')}).catch(()=>{});
  }finally{await page.close();}
}
}finally{
  result.browser=browser.version();await writeFile(join(out,'results.json'),JSON.stringify(result,null,2));await browser.close();
}
console.log(JSON.stringify(result,null,2));
if(result.views.some(v=>v.status==='FAIL'))process.exitCode=1;
