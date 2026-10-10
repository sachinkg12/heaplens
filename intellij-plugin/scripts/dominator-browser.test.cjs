// Actual generated shared renderer in Chromium; not a native JCEF/installed-plugin claim.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.HEAPLENS_PLAYWRIGHT_MODULE || 'playwright');
const html = fs.readFileSync(path.join(__dirname, '../build/generated/webview/webview/index.html'), 'utf8')
  .replaceAll('__NONCE__', 'dominator-test')
  .replace('__BRIDGE__', 'window.sentMessages = (window.sentMessages || []).concat([message]);');
const node = (id, name = 'example.Owner', type = 'Instance') => ({
  object_id: id, node_type: type, class_name: name, shallow_size: 24, retained_size: 128
});
const analysis = { command:'analysisComplete', summary:{ reachable_heap_size:1024,total_heap_size:2048,
  total_instances:100,total_arrays:1,total_classes:3,total_gc_roots:2 },
  topObjects:[], classHistogram:[], leakSuspects:[],
  topLayers:[node(42),node(44,'byte[]','Array'),node(45,'<img src=x onerror=alert(1)>')] };
let browser;
before(async () => { browser = await chromium.launch({ headless:true }); });
after(async () => { await browser?.close(); });
async function send(page, data) {
  await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', {data})), data);
}
async function latest(page) { return page.evaluate(() => window.sentMessages.at(-1)); }
const row = (page, id) => page.locator('#dominator-tree .tree-row[data-object-id="' + id + '"]').first();
for (const width of [1280,600]) test('Dominator shared tree, scoped replies, recovery and keyboard ('+width+'px)', async () => {
  const page = await browser.newPage({ viewport:{width,height:800} });
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  try {
    await page.setContent(html);
    await send(page, analysis);
    await page.locator('#tabBtn-query').click();
    await page.locator('#query-input').fill('SELECT class_name FROM instances LIMIT 1');
    await page.locator('#query-run-btn').click();
    const query = await latest(page);
    await send(page, {command:'queryResult',query:query.query,result:{columns:['class_name'],rows:[['untouched']],total_matched:1}});
    const queryState = await page.locator('#query-results').innerHTML();
    await page.locator('#tabBtn-domtree').click();
    assert.equal(await page.locator('#dominator-tree > .tree-row').count(), 3);
    assert.equal(await row(page,42).locator('.tree-pct').textContent(), '12.5%');
    assert.equal(await page.locator('#tab-domtree .tree-actions:visible').count(), 3);
    assert.equal(await page.locator('#domtree-view-flame').isVisible(), true);
    assert.equal(await page.locator('#dominator-tree img').count(), 0);
    assert.equal(await row(page,45).locator('.tree-name').textContent(), '<img src=x onerror=alert(1)>');
    await row(page,42).focus(); await page.keyboard.press('ArrowRight');
    const request = await latest(page); assert.equal(request.command, 'dominatorChildren');
    await row(page,42).click(); assert.equal((await latest(page)).requestId, request.requestId);
    const children = Array.from({length:55},(_,i)=>node(100+i, i ? 'example.Child'+i : 'java.lang.Object[]',i ? 'Instance':'Array'));
    await send(page,{...request,command:'dominatorChildrenResult',children});
    assert.equal(await page.locator('#dominator-tree .tree-children .tree-row').count(),50);
    assert.equal(await row(page,42).getAttribute('aria-expanded'),'true');
    await page.locator('#dominator-tree .tree-show-more').click();
    assert.equal(await page.locator('#dominator-tree .tree-children .tree-row').count(),55);
    await row(page,42).click(); assert.equal(await row(page,100).isVisible(),false);
    await row(page,42).click(); await row(page,42).focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await row(page,100).evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await row(page,42).evaluate(el=>el===document.activeElement),true);
    await row(page,100).click(); const empty = await latest(page);
    await send(page,{...empty,command:'dominatorChildrenResult',children:[]});
    assert.match(await row(page,100).getAttribute('class'),/leaf/);
    assert.equal(await row(page,100).getAttribute('aria-expanded'),null);
    assert.equal(await page.locator('#query-results').innerHTML(),queryState);
    await page.locator('#reset-tree-btn').click();
    await row(page,42).click(); const old = await latest(page);
    await page.locator('#reset-tree-btn').click();
    await send(page,{...old,command:'dominatorChildrenResult',children:[node(99)]});
    assert.equal(await row(page,99).count(),0);
    await row(page,42).click(); const failing = await latest(page);
    await send(page,{...failing,command:'dominatorChildrenError',error:'Please expand again'});
    assert.match(await page.locator('#dominator-status').textContent(),/expand again/);
    assert.equal(await row(page,42).getAttribute('aria-expanded'),'false');
    await row(page,42).click(); const pending = await latest(page);
    await send(page,{command:'serverCrashed'});
    await page.locator('#tabBtn-overview').click(); await page.locator('#tabBtn-domtree').click();
    assert.match(await page.locator('#dominator-tree').textContent(),/unavailable/);
    await send(page,{...pending,command:'dominatorChildrenResult',children:[node(99)]});
    assert.equal(await row(page,99).count(),0);
    await send(page,{command:'analysisProgress',stage:'loading',phase:1,totalPhases:4});
    await send(page,analysis);
    assert.equal(await page.locator('#dominator-status').textContent(),'');
    assert.equal(await page.locator('#dominator-tree > .tree-row').count(),3);
    await row(page,42).click(); const fresh = await latest(page);
    assert.notEqual(fresh.requestId,pending.requestId);
    await send(page,{...pending,command:'dominatorChildrenResult',children:[node(99)]});
    assert.equal(await row(page,99).count(),0);
    await send(page,{...fresh,command:'dominatorChildrenResult',children:[node(100,'example.Recovered')]});
    assert.equal(await row(page,100).locator('.tree-name').textContent(),'example.Recovered');
    if (process.env.HEAPLENS_LAYOUT_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.HEAPLENS_LAYOUT_EVIDENCE_DIR,{recursive:true});
      await page.screenshot({path:path.join(process.env.HEAPLENS_LAYOUT_EVIDENCE_DIR,'dominator-'+width+'.png')});
    }
    await send(page,{command:'analysisProgress',stage:'loading',phase:1,totalPhases:4});
    await send(page,{command:'analysisCancelled'});
    assert.match(await page.locator('#dominator-tree').textContent(),/cancelled/);
    await send(page,{command:'analysisProgress',stage:'loading',phase:1,totalPhases:4});
    await send(page,analysis);
    assert.equal(await page.locator('#dominator-tree > .tree-row').count(),3);
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});
