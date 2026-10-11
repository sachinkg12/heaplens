// Exercises the real generated DOM and shared renderers; host replies are deterministic mocks.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.HEAPLENS_PLAYWRIGHT_MODULE || 'playwright');
const html=fs.readFileSync(path.join(__dirname,'../build/generated/webview/webview/index.html'),'utf8')
  .replaceAll('__NONCE__','parity-test').replace('__BRIDGE__','window.sentMessages=(window.sentMessages || []).concat([message]);');
const owner={object_id:42,class_name:'example.Owner',node_type:'Instance',shallow_size:24,retained_size:256};
const analysis={command:'analysisComplete',displayName:'example.hprof',summary:{reachable_heap_size:1024,total_heap_size:2048,total_instances:10,total_classes:2,total_arrays:1,total_gc_roots:2},
  topObjects:[owner],topLayers:[owner],classHistogram:[{class_name:'example.Owner',instance_count:1,shallow_size:24,retained_size:256}],leakSuspects:[]};
let browser;
before(async()=>{browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});
async function send(page,data){await page.evaluate(data=>window.dispatchEvent(new MessageEvent('message',{data})),data);}
async function latest(page){return page.evaluate(()=>window.sentMessages.at(-1));}
async function run(body){const page=await browser.newPage({viewport:{width:1100,height:850}});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  try{await page.setContent(html);await body(page);assert.deepEqual(errors,[]);}finally{await page.close();}}
test('early summary, Why alive and shared incident report work without a network call',()=>run(async page=>{
  const network=[];page.on('request',r=>network.push(r.url()));
  await send(page,{command:'analysisProgress',stage:'graph_built',phase:3,totalPhases:4,summary:analysis.summary});
  assert.match(await page.locator('#stats-bar').textContent(),/1 KB/);
  await send(page,analysis);
  await page.locator('#top-objects-table .why-alive-btn').click();const request=await latest(page);
  assert.equal(request.command,'gcRootPath');assert.equal(request.objectId,42);
  await send(page,{...request,command:'gcRootPathResponse',path:[{...owner,class_name:'root.Owner',node_type:'Root'},owner]});
  assert.match(await page.locator('#gc-path-container').textContent(),/root.Owner/);
  await page.locator('#copy-report-btn').click();const report=await latest(page);
  assert.equal(report.command,'copyReportText');assert.match(report.text,/# HeapLens Incident Report/);
  assert.match(report.text,/example.hprof/);assert.match(report.text,/Top 10 Classes/);assert.match(report.text,/256 B/);
  await send(page,{command:'reportCopied'});assert.match(await page.locator('#report-copied').textContent(),/Copied/i);
  assert.deepEqual(network,[]);
}));
test('Dominator Inspect, Explain, references, navigation and AI Fix are host-routed',()=>run(async page=>{
  await send(page,analysis);await page.locator('#tabBtn-domtree').click();
  const row=page.locator('.tree-row[data-object-id="42"]');
  await row.hover();await row.locator('.tree-inspect').click();const inspect=await latest(page);
  assert.equal(inspect.command,'inspectObject');assert.deepEqual(Object.keys(inspect).sort(),['command','objectId','requestId']);
  await send(page,{...inspect,command:'inspectObjectResponse',fields:[{name:'token',field_type:'int',primitive_value:'LOCAL_ONLY_SECRET'}]});
  assert.match(await page.locator('#inspector-panel').textContent(),/LOCAL_ONLY_SECRET/);
  await page.locator('#inspector-explain-btn').click();const explain=await latest(page);
  assert.equal(explain.command,'explainObject');assert.deepEqual(Object.keys(explain).sort(),['command','objectId','requestId']);
  await send(page,{...explain,command:'explainChunk',text:'This object retains a buffer.'});
  await send(page,{...explain,command:'explainDone'});
  assert.match(await page.locator('#inspector-explain-area').textContent(),/retains a buffer/);
  assert.equal(await page.locator('#inspector-explain-btn').isEnabled(),true);
  await page.locator('.inspector-close').click();await row.hover();await row.locator('.tree-refs').click();const refs=await latest(page);
  assert.equal(refs.command,'getReferrers');await send(page,{...refs,command:'referrersResponse',referrers:[{...owner,object_id:43,class_name:'example.Parent',field_name:'owner'}]});
  assert.match(await page.locator('#gc-path-container').textContent(),/example.Parent/);
  await page.locator('.gc-path-close').click();await row.hover();await row.locator('.tree-source').click();
  assert.equal((await latest(page)).command,'openProjectSource');assert.equal((await latest(page)).className,'example.Owner');
  await send(page,{...await latest(page),command:'sourceNavigationResult',status:'opened'});
  await row.locator('.tree-fix').click();const fix=await latest(page);
  assert.equal(fix.command,'fixWithAi');assert.deepEqual(Object.keys(fix).sort(),['className','command','requestId']);
  await page.locator('#local-action-stop').click();assert.equal((await latest(page)).command,'cancelAiAssistance');
  await send(page,{...fix,command:'fixAiResult',message:'Cancelled before sending. Nothing was sent.'});
  assert.match(await page.locator('#local-action-status').textContent(),/Nothing was sent/);
  assert.equal(await page.locator('#local-action-stop').isVisible(),false);
}));
test('Flame Graph renders bounded subtree and errors never masquerade as empty root paths',()=>run(async page=>{
  await send(page,analysis);await page.locator('#tabBtn-domtree').click();await page.locator('#domtree-view-flame').click();
  const flame=await latest(page);assert.equal(flame.command,'getDominatorSubtree');assert.equal(flame.objectId,0);
  await send(page,{...flame,command:'dominatorSubtreeResponse',subtree:{name:'Heap',object_id:0,retained_size:1024,node_type:'SuperRoot',children:[{name:'example.Owner',object_id:42,retained_size:256,node_type:'Instance'}]}});
  assert.ok(await page.locator('#sunburst-chart svg rect').count()>0);
  await page.locator('#domtree-view-tree').click();await page.locator('.tree-row .why-alive-btn').click();const why=await latest(page);
  await send(page,{...why,command:'gcRootPathResponse',error:'Read failed. Retry the action.'});
  assert.match(await page.locator('#local-action-status').textContent(),/Read failed/);
  assert.doesNotMatch(await page.locator('#gc-path-container').textContent(),/No path/);
}));
test('Histogram export and object reads work; late replies cannot reopen panels after Retry',()=>run(async page=>{
  await send(page,analysis);await page.locator('#tabBtn-histogram').click();
  await page.locator('#export-csv-btn').click();assert.equal((await latest(page)).command,'exportHistogramCsv');assert.match((await latest(page)).csv,/25.0/);
  await page.locator('.hist-class-link').click();const selected=await latest(page);
  await send(page,{...selected,command:'histogramInstancesResult',result:{columns:['object_id','node_type','class_name','shallow_size','retained_size'],rows:[[42,'Instance','example.Owner',24,256]]}});
  await page.locator('#histogram-instances-panel .tree-inspect').click();const old=await latest(page);
  await send(page,{command:'serverCrashed'});await send(page,{command:'analysisProgress',stage:'loading',phase:1,totalPhases:4});await send(page,analysis);
  await send(page,{...old,command:'inspectObjectResponse',fields:[{name:'STALE',primitive_value:'OLD'}]});
  assert.equal(await page.locator('#inspector-panel').isVisible(),false);
  assert.doesNotMatch(await page.locator('body').textContent(),/STALE/);
}));
test('restored chats get explicit Run Query buttons and private results, never automatic execution',()=>run(async page=>{
  await send(page,analysis);await page.locator('#tabBtn-chat').click();
  const query='SELECT class_name FROM instances LIMIT 2';
  await send(page,{command:'aiHistory',messages:[{role:'user',content:'Inspect memory'},{role:'assistant',content:'Try this:\n```heapql\n'+query+'\n```'}]});
  assert.equal(await page.locator('.chat-run-query-btn').count(),1);
  assert.equal(await page.evaluate(()=>window.sentMessages.some(m=>m.command==='aiRunQuery')),false);
  await page.locator('.chat-run-query-btn').click();const request=await latest(page);assert.equal(request.command,'aiRunQuery');
  await send(page,{...request,command:'aiQueryResult',result:{columns:['class_name'],rows:[['example.Owner']]}});
  assert.match(await page.locator('.chat-query-result').textContent(),/example.Owner/);
  assert.equal(await page.locator('#query-results').textContent(),'');
  await page.locator('.chat-run-query-btn').click();const failed=await latest(page);
  await send(page,{...failed,command:'aiQueryError',error:'Unknown column: typo'});assert.match(await page.locator('#ai-status').textContent(),/Unknown column/);
  assert.equal(await page.locator('.chat-run-query-btn').isEnabled(),true);
  await page.locator('#chat-clear').click();assert.equal((await latest(page)).command,'aiClear');
  assert.equal(await page.locator('.chat-bubble').count(),0);
}));
