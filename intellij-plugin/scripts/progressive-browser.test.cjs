// Real generated DOM plus deterministic host messages; native controls remain a manual gate.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.HEAPLENS_PLAYWRIGHT_MODULE || 'playwright');
const html=fs.readFileSync(path.join(__dirname,'../build/generated/webview/webview/index.html'),'utf8').replaceAll('__NONCE__','progressive-test').replace('__BRIDGE__','window.sent=(window.sent || []).concat([message]);');
let browser;before(async()=>{browser=await chromium.launch({headless:true,...(process.env.HEAPLENS_CHROMIUM_EXECUTABLE?{executablePath:process.env.HEAPLENS_CHROMIUM_EXECUTABLE}:{})});});after(async()=>{await browser?.close();});
async function send(p,data){await p.evaluate(data=>window.dispatchEvent(new MessageEvent('message',{data})),data);}
test('Waste is explicit, ignores stale replies and recovers after an error and Retry',async()=>{
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    const full={command:'analysisComplete',summary:{total_heap_size:1024,reachable_heap_size:512,total_instances:1,total_classes:1,total_arrays:1,total_gc_roots:1},classHistogram:[],topObjects:[{object_id:512,class_name:'example.Value',node_type:'Instance',shallow_size:32,retained_size:32,child_count:0}],leakSuspects:[],wasteAnalysis:null};
    full.topLayers=full.topObjects;
    const waste={total_wasted_bytes:10,waste_percentage:1,duplicate_string_wasted_bytes:10,empty_collection_wasted_bytes:0,over_allocated_wasted_bytes:0,boxed_primitive_wasted_bytes:0,duplicate_strings:[],empty_collections:[],over_allocated_collections:[],boxed_primitives:[]};
    try {
        await page.setContent(html);await send(page,full);await page.locator('#tabBtn-waste').click();
        assert.match(await page.locator('#waste-summary-bar').innerText(),/Not calculated/);
        assert.equal((await page.evaluate(()=>window.sent)).filter(m=>m.command==='calculateWaste').length,0);
        await page.locator('#calculate-waste-btn').click();
        const first=(await page.evaluate(()=>window.sent)).at(-1);
        assert.equal(first.command,'calculateWaste');assert.equal(await page.locator('#calculate-waste-btn').isDisabled(),true);
        await send(page,{command:'wasteResult',requestId:'older',wasteAnalysis:waste});
        assert.equal(await page.locator('#calculate-waste-btn').isDisabled(),true);
        await send(page,{command:'wasteError',requestId:first.requestId,error:'Retry this calculation.'});
        assert.equal(await page.locator('#calculate-waste-btn').isEnabled(),true);
        await page.locator('#calculate-waste-btn').click();
        const second=(await page.evaluate(()=>window.sent)).at(-1);
        await send(page,{command:'wasteResult',requestId:second.requestId,wasteAnalysis:waste});
        assert.equal(await page.locator('#calculate-waste-btn').count(),0);
        assert.match(await page.locator('#waste-summary-bar').innerText(),/10 B/);
        await send(page,{command:'analysisStarting',analysisScope:'full'});
        await send(page,{command:'wasteResult',requestId:second.requestId,wasteAnalysis:waste});
        await send(page,full);await page.locator('#tabBtn-waste').click();
        assert.match(await page.locator('#waste-summary-bar').innerText(),/Not calculated/);
        assert.equal(await page.locator('#calculate-waste-btn').isEnabled(),true);
        await page.locator('#tabBtn-domtree').click();
        await page.locator('#tab-domtree .tree-inspect').first().click();
        assert.equal(await page.locator('#inspector-panel').isVisible(),true);
        await page.locator('.inspector-close').click();
        assert.deepEqual(errors,[]);
    } finally {await page.close();}
});
const scan={command:'shallowScanComplete',summary:{total_heap_size:1239216,total_instances:19047,total_arrays:11900,declared_classes:1052,total_gc_roots:996,reachable_heap_size:null},
    classHistogram:Array.from({length:405},(_,i)=>({class_name:'example.Class'+i,instance_count:1,shallow_size:16}))};
test('one full job displays partial counts, then searchable shallow results before retained analysis',async()=>{
    const page=await browser.newPage();try {
        const errors=[];page.on('pageerror',e=>errors.push(e.message));
        await page.setContent(html);await send(page,{command:'analysisStarting',analysisScope:'full'});
        await send(page,{command:'analysisProgress',stage:'graph_built',summary:{total_heap_size:1024,reachable_heap_size:1024,total_instances:10,total_classes:2,total_arrays:4,total_gc_roots:5}});
        assert.match(await page.locator('#stats-bar').innerText(),/Not calculated/);
        await send(page,{command:'analysisProgress',stage:'sizing',snapshot:{kind:'records',complete:false,instances:100,arrays:4,classes:2,roots:5}});
        assert.match(await page.locator('#stats-bar').innerText(),/so far/i);
        assert.doesNotMatch(await page.locator('#stats-bar').innerText(),/Reachable/);
        const snapshot={kind:'shallow',summary:{...scan.summary,total_classes:1052},class_histogram:scan.classHistogram};
        await send(page,{command:'analysisProgress',stage:'shallow_ready',snapshot});
        assert.match(await page.locator('#stats-bar').innerText(),/Not calculated/);
        await page.locator('#tabBtn-histogram').click();
        assert.equal(await page.locator('#shallow-histogram tbody tr').count(),200);
        assert.equal(await page.locator('#histogram-search').isEnabled(),true);
        assert.equal(await page.locator('#tabBtn-query').isDisabled(),true);
        await page.locator('#histogram-search').fill('Class404');
        await send(page,{command:'analysisProgress',stage:'edges'});
        assert.equal(await page.locator('#shallow-histogram tbody tr').count(),1);
        assert.match(await page.locator('#shallow-histogram').innerText(),/background/);
        assert.doesNotMatch(await page.locator('#shallow-histogram').innerText(),/No instance index/);
        await send(page,{command:'analysisCancelled'});
        assert.equal(await page.locator('#shallow-histogram tbody tr').count(),1);
        assert.equal(await page.locator('#tabBtn-query').isDisabled(),true);
        assert.match(await page.locator('#analysis-mode-status').innerText(),/Shallow results only/);
        await send(page,{command:'analysisStarting',analysisScope:'full'});
        assert.equal(await page.locator('#shallow-histogram').innerText(),'');
        await send(page,{command:'analysisComplete',summary:{...scan.summary,total_classes:1052,reachable_heap_size:1000000},classHistogram:[],topObjects:[],topLayers:[],leakSuspects:[]});
        assert.equal(await page.locator('#tabBtn-query').isEnabled(),true);
        assert.equal(await page.locator('#shallow-histogram').isVisible(),false);
        assert.equal((await page.evaluate(()=>window.sent)).filter(m=>['analyzeRetained','quickScan','executeQuery'].includes(m.command)).length,0);
        assert.deepEqual(errors,[]);
    }finally{await page.close();}
});
test('shallow results never trigger full tab handlers; filter, paging and CSV are local',async()=>{
    const page=await browser.newPage();try {
        const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setContent(html);await send(page,{command:'analysisStarting',analysisScope:'shallow'});await send(page,scan);
        assert.match(await page.locator('#stats-bar').innerText(),/Not calculated/);assert.match(await page.locator('#stats-bar').innerText(),/Declared classes/i);
        assert.equal(await page.locator('#tabBtn-query').isDisabled(),true);assert.equal(await page.locator('#tabBtn-chat').isDisabled(),true);
        await page.locator('#tabBtn-histogram').click();assert.equal(await page.locator('#shallow-histogram tbody tr').count(),200);
        await page.locator('#scan-next').click();assert.equal(await page.locator('#shallow-histogram tbody tr').count(),200);
        await page.locator('#scan-next').click();assert.equal(await page.locator('#shallow-histogram tbody tr').count(),5);
        await page.locator('#histogram-search').fill('Class404');assert.equal(await page.locator('#shallow-histogram tbody tr').count(),1);
        await page.locator('#scan-export').click();const messages=await page.evaluate(()=>window.sent);
        assert.equal(messages.at(-1).command,'exportHistogramCsv');assert.match(messages.at(-1).csv,/retained_status/);assert.match(messages.at(-1).csv,/not_calculated/);
        assert.equal(messages.filter(m=>['executeQuery','histogramInstances','analyzeRetained','dominatorChildren','aiSend'].includes(m.command)).length,0);
        await page.locator('#analyze-retained-btn').click();assert.equal((await page.evaluate(()=>window.sent)).at(-1).command,'analyzeRetained');
        await send(page,{command:'analysisComplete',summary:{total_heap_size:1239216,reachable_heap_size:1200000,total_instances:19047,total_arrays:11900,total_classes:1052,total_gc_roots:996},classHistogram:[],topObjects:[],topLayers:[],leakSuspects:[]});
        assert.equal(await page.locator('#tabBtn-query').isEnabled(),true);assert.equal(await page.locator('#shallow-histogram').isVisible(),false);assert.deepEqual(errors,[]);
    }finally{await page.close();}
});
test('shared status exposes only fixed storage labels and clears them on reset',async()=>{
    const page=await browser.newPage();try {
        await page.setContent(html);
        const full={command:'analysisComplete',summary:{total_heap_size:1024,reachable_heap_size:512,total_instances:0,total_classes:0,total_arrays:0,total_gc_roots:0},classHistogram:[],topObjects:[],topLayers:[],leakSuspects:[],storage:{mode:'disk',cache_status:'built',path:'PRIVATE-CANARY'}};
        await send(page,full);assert.match(await page.locator('#analysis-mode-status').innerText(),/Index built/);
        await send(page,{command:'analysisStarting',analysisScope:'full'});assert.doesNotMatch(await page.locator('#analysis-mode-status').innerText(),/Index built/);
        full.storage.cache_status='reused';await send(page,full);assert.match(await page.locator('#analysis-mode-status').innerText(),/Index reused/);
        full.storage.cache_status='PRIVATE-CANARY';await send(page,full);assert.doesNotMatch(await page.locator('#analysis-mode-status').innerText(),/PRIVATE/);
        await send(page,{command:'serverCrashed'});assert.doesNotMatch(await page.locator('#analysis-mode-status').innerText(),/Index reused/);
    }finally{await page.close();}
});
test('full-to-shallow clears stale retained results and Cancel allows Retry without auto escalation',async()=>{
    const page=await browser.newPage();try {
        await page.setContent(html);await send(page,{command:'analysisComplete',summary:{total_heap_size:1024,reachable_heap_size:512},classHistogram:[],topObjects:[],leakSuspects:[]});
        await page.locator('#quick-scan-btn').click();assert.equal((await page.evaluate(()=>window.sent)).at(-1).command,'quickScan');
        await send(page,{command:'analysisProgress',stage:'quick_scan',phase:1,totalPhases:1});await page.locator('#progress-cancel-btn').click();
        await send(page,{command:'analysisCancelled'});assert.equal(await page.locator('#quick-scan-btn').isEnabled(),true);
        await page.locator('#progress-retry-btn').click();assert.equal((await page.evaluate(()=>window.sent)).at(-1).command,'retryAnalysis');
        await send(page,scan);assert.equal(await page.locator('#report-actions').isVisible(),false);assert.equal(await page.locator('#tabBtn-domtree').isDisabled(),true);
    }finally{await page.close();}
});
