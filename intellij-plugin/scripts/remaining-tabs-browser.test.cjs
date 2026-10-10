const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.HEAPLENS_PLAYWRIGHT_MODULE || 'playwright');
const html=fs.readFileSync(path.join(__dirname,'../build/generated/webview/webview/index.html'),'utf8')
  .replaceAll('__NONCE__','remaining-tabs').replace('__BRIDGE__','window.sentMessages=(window.sentMessages || []).concat([message]);');
const summary={total_heap_size:2048,reachable_heap_size:1024,total_instances:10,total_classes:2,total_arrays:1,total_gc_roots:2};
const suspect={class_name:'example.Owner',object_id:42,retained_size:256,retained_percentage:25,description:'Retains a buffer'};
const analysis={command:'analysisComplete',summary,topObjects:[],topLayers:[],classHistogram:[],leakSuspects:[suspect],objectLeakSuspects:[suspect],
  wasteAnalysis:{total_wasted_bytes:48,waste_percentage:2.3,duplicate_string_wasted_bytes:32,empty_collection_wasted_bytes:16,
    duplicate_strings:[{preview:'LOCAL_ONLY <img src=x>',count:3,wasted_bytes:32,total_bytes:48}],empty_collections:[{class_name:'example.Empty',count:1,wasted_bytes:16}]}};
let browser;before(async()=>{browser=await chromium.launch({headless:true});});after(async()=>{await browser?.close();});
async function send(page,data){await page.evaluate(data=>window.dispatchEvent(new MessageEvent('message',{data})),data);}
async function latest(page){return page.evaluate(()=>window.sentMessages.at(-1));}
async function run(body){const page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));try{await page.setContent(html);await send(page,analysis);await body(page);assert.deepEqual(errors,[]);}finally{await page.close();}}
test('all eleven tabs boot and Leak Suspects actions use the protected host bridge',()=>run(async page=>{
  assert.equal(await page.locator('.tab-btn').count(),11);await page.locator('#tabBtn-leaks').click();
  assert.match(await page.locator('#object-suspects').textContent(),/example.Owner/);
  await page.locator('#object-suspects .gc-path-link').click();assert.equal((await latest(page)).command,'gcRootPath');
  await page.locator('#object-suspects .suspect-explain-link').click();const request=await latest(page);
  assert.equal(request.command,'explainLeakSuspect');assert.deepEqual(Object.keys(request).sort(),['className','command','objectId','requestId']);
  await send(page,{...request,command:'explainLeakChunk',text:'**Investigate ownership.**'});
  await send(page,{...request,command:'explainLeakDone'});
  assert.match(await page.locator('#object-suspects').textContent(),/Investigate ownership/);
  assert.equal(await page.locator('#object-suspects .suspect-explain-link').textContent(),'Explain');
  await page.locator('#leak-threshold-slider').fill('30');await page.locator('#leak-threshold-slider').dispatchEvent('input');
  assert.match(await page.locator('#object-suspects').textContent(),/No suspects at current threshold/);
  await send(page,{command:'serverCrashed'});await send(page,{...request,command:'explainLeakChunk',text:'STALE'});
  assert.doesNotMatch(await page.locator('#object-suspects').textContent(),/STALE/);
}));
test('Waste filters locally, escapes previews and clears old data on Retry',()=>run(async page=>{
  await page.locator('#tabBtn-waste').click();assert.match(await page.locator('#waste-summary-bar').textContent(),/48 B/);
  assert.match(await page.locator('#waste-dup-table').textContent(),/LOCAL_ONLY/);assert.equal(await page.locator('#waste-dup-table img').count(),0);
  await page.locator('#waste-search').fill('example.Empty');assert.equal(await page.locator('#waste-dup-table tbody tr').count(),0);
  assert.match(await page.locator('#waste-empty-table').textContent(),/example.Empty/);
  await send(page,{command:'analysisProgress',stage:'loading'});assert.doesNotMatch(await page.locator('#tab-waste').textContent(),/LOCAL_ONLY|example.Empty/);
}));
function comparison(){const sd={};for(const [k,v] of Object.entries(summary)){sd['baseline_'+k]=v;sd['current_'+k]=v*2;sd[k+'_delta']=v;}
  return {baseline_path:'before.hprof',current_path:'after.hprof',summary_delta:sd,histogram_delta:[{class_name:'example.Owner',change_type:'grew',instance_count_delta:1,shallow_size_delta:24,retained_size_delta:256,
    baseline_instance_count:1,baseline_shallow_size:24,baseline_retained_size:256,current_instance_count:2,current_shallow_size:48,current_retained_size:512}],leak_suspect_changes:[]};}
test('Compare selects opaque IDs, renders deltas, exports and rejects stale results',()=>run(async page=>{
  await page.locator('#tabBtn-compare').click();assert.equal((await latest(page)).command,'listAnalyzedFiles');
  await send(page,{command:'analyzedFiles',files:['opaque-before'],labels:{'opaque-before':'before.hprof'}});
  assert.equal(await page.locator('#compare-select option').last().textContent(),'before.hprof');
  await page.locator('#compare-select').selectOption('opaque-before');await page.locator('#compare-btn').click();const req=await latest(page);
  assert.equal(req.command,'compareHeaps');assert.equal(req.baselinePath,'opaque-before');
  await send(page,{...req,command:'compareResult',result:comparison()});assert.match(await page.locator('#compare-results').textContent(),/example.Owner/);
  await page.locator('#compare-export-csv-btn').click();assert.equal((await latest(page)).command,'exportCompareCsv');assert.match((await latest(page)).csv,/example.Owner/);
  await page.locator('#compare-export-md-btn').click();assert.equal((await latest(page)).command,'exportCompareMarkdown');
  await page.locator('#compare-btn').click();const old=await latest(page);await send(page,{command:'snapshotsChanged'});
  await send(page,{...old,command:'compareResult',result:comparison()});assert.equal(await page.locator('#compare-results').textContent(),'');
  assert.equal(await page.locator('#compare-export-csv-btn').isVisible(),false);
}));
test('Timeline charts, labels, changed-snapshot reset and error recovery',()=>run(async page=>{
  await page.locator('#tabBtn-timeline').click();await send(page,{command:'allAnalyzedFiles',files:['a','b'],labels:{a:'before.hprof',b:'after.hprof'}});
  assert.match(await page.locator('#timeline-file-list').textContent(),/before.hprof/);await page.locator('#timeline-build-btn').click();const req=await latest(page);
  assert.deepEqual(req.paths,['a','b']);await send(page,{...req,command:'timelineDataResponse',result:{snapshots:[
    {path:'before.hprof',summary,top_classes:[{class_name:'example.Owner',retained_size:100}]},
    {path:'after.hprof',summary:{...summary,total_heap_size:4096},top_classes:[{class_name:'example.Owner',retained_size:200}]}]}});
  assert.ok(await page.locator('#timeline-charts svg').count()>=2);assert.match(await page.locator('#timeline-charts').textContent(),/example.Owner/);
  await page.locator('#timeline-build-btn').click();const failed=await latest(page);await send(page,{...failed,command:'timelineError',error:'Selection changed'});
  assert.equal(await page.locator('#timeline-build-btn').isEnabled(),true);assert.match(await page.locator('#timeline-charts').textContent(),/Selection changed/);
  await send(page,{command:'snapshotsChanged'});assert.equal(await page.locator('#timeline-charts svg').count(),0);
}));
test('Monitor connects only on click, renders metrics, recovers cancelled histogram and disconnects',()=>run(async page=>{
  assert.equal(await page.evaluate(()=>window.sentMessages.some(m=>m.command==='startMonitor')),false);
  await page.locator('#tabBtn-monitor').click();await page.locator('#monitor-connect-btn').click();assert.equal((await latest(page)).command,'startMonitor');
  await send(page,{command:'monitorConnected'});const data={timestamp:1,heapUsed:512,heapMax:1024,heapCommitted:1024,nonHeapUsed:128,nonHeapCommitted:256,threadCount:3,daemonThreadCount:1,uptime:10000,gcCollectors:[],memoryPools:[]};
  await send(page,{command:'monitorMetrics',data});await send(page,{command:'monitorMetrics',data:{...data,timestamp:2}});
  assert.ok(await page.locator('#monitor-gauge svg').count()>0);assert.ok(await page.locator('#monitor-line-chart svg').count()>0);
  await page.locator('#monitor-histogram-btn').click();assert.equal((await latest(page)).command,'requestMonitorHistogram');
  await send(page,{command:'monitorError',message:'Histogram request cancelled.'});assert.equal(await page.locator('#monitor-histogram-btn').isEnabled(),true);
  assert.equal(await page.locator('#monitor-connect-btn').isEnabled(),false);
  await page.locator('#monitor-histogram-btn').click();await send(page,{command:'monitorHistogram',data:[{className:'example.Payload',instanceCount:2,totalBytes:32}]});
  assert.match(await page.locator('#monitor-histogram-table').textContent(),/example.Payload/);
  await page.locator('#monitor-disconnect-btn').click();assert.equal((await latest(page)).command,'stopMonitor');await send(page,{command:'monitorDisconnected'});
  assert.equal(await page.locator('#monitor-connect-btn').isEnabled(),true);
}));
