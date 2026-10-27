// Real shared renderers in Chromium, synthetic inputs, no external services.
'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require(process.env.HEAPLENS_PLAYWRIGHT_MODULE||'playwright');
const load=(file,fn)=>require('../out/webview/'+file)[fn]();
const html='<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-percentage-test\'; style-src \'unsafe-inline\'"><style>:root{--vscode-foreground:#202124;--vscode-editor-background:#fff;--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-editorWidget-background:#eee;--vscode-panel-border:#ccc;--vscode-button-background:#176ac5;--vscode-button-foreground:#fff;}'+load('styles','getStyles')+'</style></head><body>'+load('template','getHtmlTemplate')+
    '<script nonce="percentage-test">var analysisData=null, depInfoCache={}; function isResolvableClass(){return false;} const vscode={postMessage:message=>window.sent.push(message)};window.sent=[];'+
    load('js/registry','getRegistryJs')+load('js/helpers','getHelperJs')+load('js/histogram','getHistogramJs')+
    load('js/dominatorTree','getDominatorTreeJs')+load('js/overview','getOverviewJs')+load('js/progressive','getProgressiveJs')+
    'onMessage("analysisComplete",message=>{analysisData=message;});</script></body></html>';
const object=(id,retained)=>({object_id:id,class_name:'example.Owner',node_type:'Instance',shallow_size:24,retained_size:retained});
const analysis=(reachable=1000)=>({command:'analysisComplete',summary:{reachable_heap_size:reachable,total_heap_size:2000,
    total_instances:4,total_arrays:0,total_classes:2,total_gc_roots:1},topObjects:[],leakSuspects:[],
    topLayers:[object(1,100),object(2,100),object(3,300)],
    classHistogram:[{class_name:'example.Cache',instance_count:4,shallow_size:96,retained_size:250}]});
let browser;
before(async()=>{browser=await chromium.launch({headless:true,
    ...(process.env.HEAPLENS_CHROMIUM_EXECUTABLE?{executablePath:process.env.HEAPLENS_CHROMIUM_EXECUTABLE}:{})});});
after(async()=>{await browser?.close();});
const send=(page,message)=>page.evaluate(data=>window.dispatchEvent(new MessageEvent('message',{data})),message);
for(const width of [1280,600])test('heap percentages, child rows, recovery and editor isolation at '+width+'px',async()=>{
    const page=await browser.newPage({viewport:{width,height:850}}), other=await browser.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(String(error)));
    await page.route('**/*',route=>route.abort());await other.route('**/*',route=>route.abort());
    try{
        await page.setContent(html);await other.setContent(html);
        await send(page,analysis());await send(other,analysis(2000));
        assert.match(await page.locator('#diagnosis-section').innerText(),/25\.0%/);
        await page.locator('#tabBtn-domtree').click();await other.locator('#tabBtn-domtree').click();
        const row=id=>page.locator('#dominator-tree .tree-row[data-object-id="'+id+'"]').first();
        assert.equal(await row(1).locator('.tree-pct').innerText(),'10.0%');
        assert.equal(await other.locator('#dominator-tree .tree-row[data-object-id="1"] .tree-pct').innerText(),'5.0%');
        assert.match(await page.locator('#domtree-header').innerText(),/% reachable/);
        if(process.env.HEAPLENS_PERCENTAGE_EVIDENCE_DIR){
            fs.mkdirSync(process.env.HEAPLENS_PERCENTAGE_EVIDENCE_DIR,{recursive:true});
            await page.screenshot({path:path.join(process.env.HEAPLENS_PERCENTAGE_EVIDENCE_DIR,'dominator-percentage-'+width+'.png')});
        }
        await row(1).click();await send(page,{command:'childrenResponse',objectId:1,children:[object(4,50)]});
        assert.equal(await row(4).locator('.tree-pct').innerText(),'5.0%');
        await page.locator('#reset-tree-btn').click();assert.equal(await row(4).count(),0);
        assert.equal(await row(1).locator('.tree-pct').innerText(),'10.0%');
        await send(page,{command:'analysisStarting',analysisScope:'full'});
        assert.equal(await page.locator('#dominator-tree .tree-row').count(),0);
        await send(page,analysis(500));await page.locator('#tabBtn-domtree').click();
        assert.equal(await row(1).locator('.tree-pct').innerText(),'20.0%');
        for(const command of ['analysisCancelled','analysisFailed','serverCrashed']){
            await send(page,{command});assert.equal(await page.locator('#dominator-tree .tree-row').count(),0);
            await send(page,{command:'analysisStarting',analysisScope:'full'});await send(page,analysis(0));
            await page.locator('#tabBtn-domtree').click();
            assert.equal(await row(1).locator('.tree-pct').innerText(),'N/A');
            assert.equal(await page.locator('#diagnosis-section').innerText(),'');
        }
        assert.deepEqual(errors,[]);
    }finally{await page.close();await other.close();}
});
