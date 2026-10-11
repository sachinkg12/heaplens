// Real generated DOM, deterministic host replies. Native LAF/merge/Undo remain installed-IDE gates.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.HEAPLENS_PLAYWRIGHT_MODULE || 'playwright');
const html=fs.readFileSync(path.join(__dirname,'../build/generated/webview/webview/index.html'),'utf8')
  .replaceAll('__NONCE__','observations-test').replace('__BRIDGE__','window.sentMessages=(window.sentMessages || []).concat([message]);');
const owner={object_id:42,class_name:'example.Owner',node_type:'Instance',shallow_size:24,retained_size:256};
const analysis={command:'analysisComplete',summary:{reachable_heap_size:1024,total_heap_size:2048,total_instances:10,total_classes:2,total_arrays:1,total_gc_roots:2},
  topObjects:[owner],topLayers:[owner],classHistogram:[{class_name:'example.Owner',instance_count:1,shallow_size:24,retained_size:256},
  {class_name:'java.lang.String',instance_count:2,shallow_size:48,retained_size:100}],leakSuspects:[]};
let browser;
before(async()=>{browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});
async function send(page,data){await page.evaluate(data=>window.dispatchEvent(new MessageEvent('message',{data})),data);}
async function latest(page){return page.evaluate(()=>window.sentMessages.at(-1));}
async function run(body){const page=await browser.newPage({viewport:{width:1100,height:650}});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  try{await page.setContent(html);await send(page,analysis);await body(page);assert.deepEqual(errors,[]);}finally{await page.close();}}
test('appearance changes update existing surfaces safely without analysis or state reset',()=>run(async page=>{
  await page.locator('#tabBtn-source').click();await page.locator('#source-search').fill('Owner');
  const requestsBefore=await page.evaluate(()=>window.sentMessages.length);
  for(const dark of [false,true,false]){
    const colors={'--vscode-editor-background':dark?'#202124':'#ffffff','--vscode-foreground':dark?'#ededed':'#202124',
      '--vscode-editorGroupHeader-tabsBackground':dark?'#202124':'#f4f5f7','--vscode-editorWidget-background':dark?'#28292c':'#f4f5f7',
      '--vscode-input-background':dark?'#303134':'#ffffff','--vscode-input-foreground':dark?'#ededed':'#202124',
      '--hl-scrollbar-thumb':dark?'#969aa3':'#747b85'};
    await send(page,{command:'hostAppearance',dark,colors});
    assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),dark?'rgb(32, 33, 36)':'rgb(255, 255, 255)');
    assert.equal(await page.locator('.tab-bar').evaluate(el=>getComputedStyle(el).backgroundColor),dark?'rgb(32, 33, 36)':'rgb(244, 245, 247)');
    assert.equal(await page.locator('#source-table th').first().evaluate(el=>getComputedStyle(el).backgroundColor),dark?'rgb(40, 41, 44)':'rgb(244, 245, 247)');
    assert.equal(await page.locator('#source-search').inputValue(),'Owner');
    assert.equal(await page.locator('#source-hint').evaluate(el=>getComputedStyle(el).fontSize),'13px');
    if(process.env.HEAPLENS_LAYOUT_EVIDENCE_DIR)await page.screenshot({path:path.join(process.env.HEAPLENS_LAYOUT_EVIDENCE_DIR,dark?'observations-dark.png':'observations-light.png')});
  }
  await send(page,{command:'hostAppearance',dark:false,colors:{'--vscode-editor-background':'url(https://invalid.test)','--evil':'#000000'}});
  assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--evil')),'');
  assert.equal(await page.evaluate(()=>window.sentMessages.length),requestsBefore);
}));
test('Overview warnings are yellow/amber initially and after theme changes; critical stays red',()=>run(async page=>{
  await send(page,{...analysis,leakSuspects:[
    {class_name:'example.Warning',retained_size:256,retained_percentage:25},
    {class_name:'example.Critical',retained_size:700,retained_percentage:68}]
  });
  const warning=page.locator('.diagnosis-card.warning');
  const critical=page.locator('.diagnosis-card.critical');
  assert.equal(await warning.locator('.diagnosis-severity').evaluate(el=>getComputedStyle(el).color),'rgb(242, 197, 92)');
  for(const dark of [false,true,false]){
    await send(page,{command:'hostAppearance',dark,colors:{
      '--vscode-editorWarning-foreground':dark?'#f2c55c':'#946200',
      '--vscode-editorError-foreground':dark?'#ff7777':'#b42318'
    }});
    const warn=dark?'rgb(242, 197, 92)':'rgb(148, 98, 0)';
    assert.equal(await warning.locator('.diagnosis-severity').evaluate(el=>getComputedStyle(el).color),warn);
    assert.equal(await warning.evaluate(el=>getComputedStyle(el).borderLeftColor),warn);
    assert.equal(await critical.locator('.diagnosis-severity').evaluate(el=>getComputedStyle(el).color),dark?'rgb(255, 119, 119)':'rgb(180, 35, 24)');
  }
}));
test('AI failures are red alerts; cancellation, completion, dismissal and stale replies do not retain error styling',()=>run(async page=>{
  await page.locator('#tabBtn-source').click();
  const row=page.locator('#source-table tr[data-source-class="example.Owner"]');
  const status=page.locator('#local-action-status');
  for(const dark of [false,true]){
    await send(page,{command:'hostAppearance',dark,colors:{'--vscode-editorError-foreground':dark?'#ff7777':'#b42318'}});
    await row.locator('.source-fix-btn').click();const failed=await latest(page);
    await send(page,{...failed,command:'fixAiResult',level:'error',message:'AI configuration is unavailable. Use Configure AI.'});
    assert.equal(await status.evaluate(el=>getComputedStyle(el).color),dark?'rgb(255, 119, 119)':'rgb(180, 35, 24)');
    assert.equal(await status.getAttribute('role'),'alert');assert.equal(await status.getAttribute('aria-live'),'assertive');
    assert.equal(await page.locator('#local-action-stop').isVisible(),false);
    await row.locator('.source-fix-btn').click();const cancelled=await latest(page);
    assert.equal(await status.getAttribute('role'),'status');
    await send(page,{...cancelled,command:'fixAiResult',level:'info',message:'Cancelled before sending. Nothing was sent.'});
    assert.equal(await status.getAttribute('role'),'status');
    assert.equal(await status.getAttribute('aria-live'),'polite');
    assert.equal(await status.evaluate(el=>el.classList.contains('local-action-error')),false);
    await send(page,{...failed,command:'fixAiResult',level:'error',message:'stale failure'});
    assert.match(await status.textContent(),/Nothing was sent/);
    await row.locator('.source-fix-btn').click();const completed=await latest(page);
    await send(page,{...completed,command:'fixAiResult',level:'info',message:'AI proposal opened for review.'});
    assert.equal(await status.getAttribute('role'),'status');
    await page.locator('#local-action-dismiss').click();assert.equal(await page.locator('#local-action-bar').isVisible(),false);
  }
}));
test('source feedback stays in its tab and idle Stop hides; expired replies cannot revive it',()=>run(async page=>{
  await page.locator('#tabBtn-domtree').click();const row=page.locator('.tree-row[data-object-id="42"]');
  await row.hover();await row.locator('.tree-source').click();const source=await latest(page);
  await row.locator('.tree-source').click();assert.equal((await latest(page)).requestId,source.requestId);
  await page.locator('#tabBtn-source').click();
  await send(page,{...source,command:'sourceNavigationResult',status:'not-found'});
  assert.equal(await page.locator('#local-action-stop').isVisible(),false);
  assert.equal(await page.locator('#local-action-bar').isVisible(),false);
  await page.locator('#tabBtn-domtree').click();
  assert.match(await page.locator('#tab-domtree .local-source-feedback').textContent(),/example.Owner: No matching/);
  await page.locator('#tab-domtree .local-source-feedback button').click();
  assert.equal(await page.locator('#tab-domtree .local-source-feedback').isVisible(),false);
  await send(page,{command:'analysisProgress',stage:'loading',phase:1,totalPhases:4});await send(page,analysis);
  await send(page,{...source,command:'sourceNavigationResult',status:'opened'});
  assert.equal(await page.locator('#local-action-stop').isVisible(),false);
  assert.equal(await page.locator('#tab-domtree .local-source-feedback').isVisible(),false);
}));
test('Fix starts independently of Source navigation; Stop shows only during active AI',()=>run(async page=>{
  await page.locator('#tabBtn-source').click();
  const row=page.locator('#source-table tr[data-source-class="example.Owner"]');
  const library=page.locator('#source-table tr[data-source-class="java.lang.String"]');
  assert.equal(await row.locator('.source-fix-btn').isEnabled(),true);
  assert.equal(await library.locator('.source-fix-btn').isEnabled(),true);
  await row.locator('.source-fix-btn').click();const direct=await latest(page);
  assert.equal(direct.command,'fixWithAi');
  assert.equal(await page.evaluate(()=>window.sentMessages.some(m=>m.command==='openProjectSource')),false);
  assert.deepEqual(Object.keys(direct).sort(),['className','command','requestId']);
  await send(page,{...direct,command:'fixAiResult',level:'info',message:'Cancelled before sending. Nothing was sent.'});
  await library.locator('.source-view-btn').click();const lookup=await latest(page);
  await send(page,{...lookup,command:'sourceNavigationResult',status:'dependency-source'});
  assert.equal(await library.locator('.source-fix-btn').isEnabled(),true);
  await library.locator('.source-fix-btn').click();const libraryFix=await latest(page);
  await send(page,{...libraryFix,command:'fixAiResult',level:'error',message:'No writable project Java source selected. No AI request was made.'});
  assert.equal(await page.locator('#local-action-stop').isVisible(),false);
  for(const status of ['not-found','opened-read-only','opened']){
    await row.locator('.source-view-btn').click();const request=await latest(page);
    await send(page,{...request,command:'sourceNavigationResult',status});
    assert.equal(await row.locator('.source-fix-btn').isEnabled(),true);
  }
  await row.locator('.source-fix-btn').click();const fix=await latest(page);assert.equal(fix.command,'fixWithAi');
  assert.equal(await page.locator('#local-action-stop').isVisible(),true);
  await page.locator('#local-action-stop').click();assert.equal((await latest(page)).command,'cancelAiAssistance');
  await send(page,{...fix,command:'fixAiResult',message:'Cancelled before sending. Nothing was sent.'});
  assert.equal(await page.locator('#local-action-stop').isVisible(),false);
  assert.match(await page.locator('#local-action-status').textContent(),/Nothing was sent/);
  await page.locator('#local-action-dismiss').click();assert.equal(await page.locator('#local-action-bar').isVisible(),false);
}));
test('Dominator and Leak Suspects Fix work without opening Source, including after Retry',()=>run(async page=>{
  const data={...analysis,leakSuspects:[{class_name:'example.Owner',retained_size:256,retained_percentage:25}],
    objectLeakSuspects:[{class_name:'example.Owner',object_id:42,retained_size:256,retained_percentage:25}]};
  await send(page,data);
  for(const tab of ['domtree','leaks']){
    await page.locator('#tabBtn-'+tab).click();
    if(tab==='leaks')await page.locator('.leak-toggle-btn[data-view="class"]').click();
    const button=tab==='domtree'?page.locator('.tree-row[data-object-id="42"] .tree-fix'):
      page.locator('#leak-suspects .fix-with-ai-link');
    if(tab==='domtree')await page.locator('.tree-row[data-object-id="42"]').hover();
    assert.equal(await button.isEnabled(),true);await button.click();const request=await latest(page);
    assert.equal(request.command,'fixWithAi');assert.equal(request.className,'example.Owner');
    await send(page,{...request,command:'fixAiResult',level:'info',message:'Cancelled before sending. Nothing was sent.'});
  }
  assert.equal(await page.evaluate(()=>window.sentMessages.some(m=>m.command==='openProjectSource')),false);
  await send(page,{command:'serverCrashed'});
  await send(page,{command:'analysisProgress',stage:'loading',phase:1,totalPhases:4});await send(page,data);
  await page.locator('#tabBtn-domtree').click();await page.locator('.tree-row[data-object-id="42"]').hover();
  await page.locator('.tree-row[data-object-id="42"] .tree-fix').click();assert.equal((await latest(page)).command,'fixWithAi');
  assert.equal(await page.evaluate(()=>window.sentMessages.some(m=>m.command==='openProjectSource')),false);
}));
test('overflow keeps a contrasted scroll thumb and wheel/keyboard access in both themes',()=>run(async page=>{
  await page.locator('#tabBtn-query').click();await page.locator('#query-input').fill('SELECT class_name FROM instances');
  await page.locator('#query-run-btn').click();
  await send(page,{command:'queryResult',query:'SELECT class_name FROM instances',result:{columns:['class_name'],rows:Array.from({length:100},(_,i)=>['sample.C'+i]),total_matched:100}});
  const pane=page.locator('#tab-query');
  for(const dark of [false,true]){
    await send(page,{command:'hostAppearance',dark,colors:{'--vscode-editor-background':dark?'#202124':'#ffffff','--hl-scrollbar-thumb':dark?'#969aa3':'#747b85'}});
    const geometry=await pane.evaluate(el=>({scroll:el.scrollHeight,client:el.clientHeight,
      thumb:getComputedStyle(el,'::-webkit-scrollbar-thumb').backgroundColor,width:getComputedStyle(el,'::-webkit-scrollbar').width}));
    assert.ok(geometry.scroll>geometry.client);assert.equal(geometry.width,'12px');
    assert.equal(geometry.thumb,dark?'rgb(150, 154, 163)':'rgb(116, 123, 133)');
    await pane.hover();await page.mouse.wheel(0,600);await page.waitForTimeout(100);
    assert.ok(await pane.evaluate(el=>el.scrollTop)>0);
    await pane.evaluate(el=>{el.tabIndex=0;el.focus();el.scrollTop=0;});await page.keyboard.press('PageDown');await page.waitForTimeout(100);
    assert.ok(await pane.evaluate(el=>el.scrollTop)>0);
    assert.ok(await page.locator('.tab-bar').evaluate(el=>el.getBoundingClientRect().top)>=0);
  }
}));
