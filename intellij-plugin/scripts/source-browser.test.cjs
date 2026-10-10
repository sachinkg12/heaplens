// Full generated renderer in Chromium; native project indexing/navigation remains a manual gate.
const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.HEAPLENS_PLAYWRIGHT_MODULE || 'playwright');
const html = fs.readFileSync(path.join(__dirname,'../build/generated/webview/webview/index.html'),'utf8')
  .replaceAll('__NONCE__','source-test')
  .replace('__BRIDGE__','window.sentMessages = (window.sentMessages || []).concat([message]);');
const entry = (name,size=128) => ({class_name:name,instance_count:2,shallow_size:48,retained_size:size});
const analysis = {command:'analysisComplete',summary:{reachable_heap_size:1024,total_heap_size:2048,
  total_instances:100,total_arrays:1,total_classes:3,total_gc_roots:2},
  topObjects:[],topLayers:[],leakSuspects:[],classHistogram:[
    entry('example.Owner$Inner'),entry('example.Other',64),entry('example.Owner$Inner'),
    entry('java.lang.String'),entry('byte[][]'),entry('<img src=x onerror=alert(1)>'),
    entry('constructor'),entry('__proto__'),entry('例.Café'),entry('class example.Owner')]};
let browser;
before(async()=>{browser = await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});
async function send(page,data) { await page.evaluate(data=>window.dispatchEvent(new MessageEvent('message',{data})),data); }
async function latest(page) {return page.evaluate(()=>window.sentMessages.at(-1));}
const row = (page,name) => page.locator('#source-table tr').filter({has:page.locator('td:first-child',{hasText:name})}).first();
for (const fontSize of [13,17]) test('IntelliJ help paragraphs follow the host font-size token ('+fontSize+'px)',async()=>{
  const page = await browser.newPage({viewport:{width:1280,height:800}});
  try {
    await page.setContent(html); await send(page,analysis);
    if (fontSize !== 13) await page.evaluate(size=>
      document.documentElement.style.setProperty('--vscode-font-size',size+'px'),fontSize);
    await page.locator('#tabBtn-source').click();
    await row(page,'example.Owner$Inner').getByRole('button',{name:'View Source'}).click();
    await send(page,{...await latest(page),command:'sourceNavigationResult',status:'not-found'});
    for (const selector of ['#source-hint','#source-status']) {
      assert.equal(await page.locator(selector).evaluate(el=>getComputedStyle(el).fontSize),fontSize+'px');
    }
    assert.match(await page.locator('#source-hint').textContent(),/explicit approval to send the entire file/);
    assert.equal(await page.locator('#source-table table').evaluate(el=>getComputedStyle(el).fontSize),'13px');
    assert.equal(await row(page,'example.Owner$Inner').locator('.source-view-btn')
      .evaluate(el=>getComputedStyle(el).fontSize),'11px');
    for (const [tab,selector] of [['timeline','#tab-timeline .timeline-controls > p'],['monitor','#tab-monitor .monitor-histogram-section > p']]) {
      await page.locator('#tabBtn-'+tab).click();
      assert.equal(await page.locator(selector).count(),1,'Help paragraph exists: '+selector);
      assert.equal(await page.locator(selector).evaluate(el=>getComputedStyle(el).fontSize),fontSize+'px');
    }
    await page.locator('#tabBtn-domtree').click();
    assert.equal(await page.locator('.dominator-hint').evaluate(el=>getComputedStyle(el).fontSize),'12px',
      'Existing compact per-view typography must remain unchanged');
  } finally {await page.close();}
});
for (const width of [1280,600]) test('Source local actions, statuses and recovery ('+width+'px)',async()=>{
  const page = await browser.newPage({viewport:{width,height:800}});
  const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
  try {
    await page.setContent(html); await send(page,analysis);
    await page.locator('#tabBtn-query').click();
    await page.locator('#query-input').fill('SELECT class_name FROM instances LIMIT 1');
    await page.locator('#query-run-btn').click();
    await send(page,{command:'queryResult',query:'SELECT class_name FROM instances LIMIT 1',result:{columns:['class_name'],rows:[['preserved']],total_matched:1}});
    const queryState = await page.locator('#query-results').innerHTML();
    await page.locator('#tabBtn-source').click();
    assert.equal(await page.locator('#source-table tbody tr').count(),7);
    assert.equal(await page.locator('#source-table img').count(),0);
    assert.equal(await page.locator('#source-table .source-fix-btn').count(),7);
    assert.match(await page.locator('#source-hint').textContent(),/explicit approval/);
    await row(page,'example.Owner$Inner').getByRole('button',{name:'View Source'}).click();
    const first = await latest(page);
    assert.deepEqual(Object.keys(first).sort(),['className','command','requestId']);
    assert.equal(first.command,'openProjectSource');
    assert.equal(first.className,'example.Owner$Inner');
    assert.equal(await page.locator('#source-table .source-view-btn:not(:disabled)').count(),0);
    await send(page,{...first,command:'sourceNavigationResult',status:'indexing'});
    assert.match(await page.locator('#source-status').textContent(),/Waiting for project indexing/);
    await send(page,{...first,command:'sourceNavigationResult',status:'opened'});
    assert.match(await page.locator('#source-stats').textContent(),/1 opened locally/);
    await row(page,'example.Owner$Inner').getByRole('button',{name:'Open Again'}).click();
    const reopen=await latest(page); assert.notEqual(reopen.requestId,first.requestId);
    await send(page,{...first,command:'sourceNavigationResult',status:'not-found'});
    assert.match(await page.locator('#source-status').textContent(),/Looking/);
    await send(page,{...reopen,command:'sourceNavigationResult',status:'cancelled'});
    assert.match(await page.locator('#source-status').textContent(),/Selection cancelled/);
    for(const status of ['not-found','error','too-many','opened']) {
      await row(page,'example.Other').locator('.source-view-btn').click();
      await send(page,{...await latest(page),command:'sourceNavigationResult',status});
      assert.equal(await row(page,'example.Other').locator('.source-view-btn').isEnabled(),true);
    }
    assert.equal(await page.locator('#query-results').innerHTML(),queryState);
    await page.locator('#source-search').fill('owner$inner');
    assert.equal(await page.locator('#source-table tbody tr').count(),1);
    await row(page,'example.Owner$Inner').locator('.source-view-btn').click(); const pending=await latest(page);
    await send(page,{command:'serverCrashed'});
    await page.locator('#tabBtn-overview').click(); await page.locator('#tabBtn-source').click();
    assert.match(await page.locator('#source-table').textContent(),/unavailable/);
    await send(page,{...pending,command:'sourceNavigationResult',status:'opened'});
    assert.match(await page.locator('#source-table').textContent(),/unavailable/);
    await send(page,{command:'analysisProgress',stage:'loading',phase:1,totalPhases:4}); await send(page,analysis);
    assert.equal(await page.locator('#source-status').textContent(),'');
    assert.equal(await page.locator('#source-search').isEnabled(),true);
    await row(page,'example.Owner$Inner').locator('.source-view-btn').click(); const fresh=await latest(page);
    assert.notEqual(fresh.requestId,pending.requestId);
    await send(page,{...pending,command:'sourceNavigationResult',status:'opened'});
    assert.match(await page.locator('#source-status').textContent(),/Looking/);
    await send(page,{...fresh,command:'sourceNavigationResult',status:'opened'});
    await page.locator('#source-search').fill('');
    if(process.env.HEAPLENS_LAYOUT_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.HEAPLENS_LAYOUT_EVIDENCE_DIR,{recursive:true});
      await page.screenshot({path:path.join(process.env.HEAPLENS_LAYOUT_EVIDENCE_DIR,'source-'+width+'.png')});
    }
    await send(page,{command:'analysisCancelled'});
    assert.match(await page.locator('#source-table').textContent(),/cancelled/);
    assert.deepEqual(errors,[]);
  } finally {await page.close();}
});
test('Source render is capped, filtering reaches beyond cap and sorting is preserved',async()=>{
  const page=await browser.newPage();
  try {
    await page.setContent(html); await send(page,{...analysis,classHistogram:Array.from({length:205},(_,i)=>entry('sample.C'+i,i))});
    await page.locator('#tabBtn-source').click();
    assert.equal(await page.locator('#source-table tbody tr').count(),200);
    assert.match(await page.locator('#source-stats').textContent(),/Showing 200 of 205.*Filter/);
    assert.equal(await page.locator('#source-table tbody tr:first-child td:first-child').textContent(),'sample.C204');
    await page.locator('#source-search').fill('sample.c0');
    assert.equal(await page.locator('#source-table tbody tr').count(),1);
    assert.equal(await page.locator('#source-table td:first-child').textContent(),'sample.C0');
    await page.locator('#source-search').fill('');
    await page.locator('#source-table th[data-source-sort="retained_size"]').click();
    assert.equal(await page.locator('#source-table tbody tr:first-child td:first-child').textContent(),'sample.C0');
  } finally {await page.close();}
});
