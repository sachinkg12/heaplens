// Actual generated UI in Chromium, with mocked native consent/transport replies.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.HEAPLENS_PLAYWRIGHT_MODULE || 'playwright');
const html=fs.readFileSync(path.join(__dirname,'../build/generated/webview/webview/index.html'),'utf8')
  .replaceAll('__NONCE__','chat-test').replace('__BRIDGE__','window.sentMessages=(window.sentMessages || []).concat([message]);');
const analysis={command:'analysisComplete',summary:{reachable_heap_size:1024,total_heap_size:2048,total_instances:10,total_arrays:1,total_classes:3,total_gc_roots:2},topObjects:[],topLayers:[],leakSuspects:[],classHistogram:[]};
let browser;
before(async()=>{browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});
async function send(page,data){await page.evaluate(data=>window.dispatchEvent(new MessageEvent('message',{data})),data);}
async function latest(page){return page.evaluate(()=>window.sentMessages.at(-1));}
for(const width of [1280,600]) test('AI streaming, safe rendering, cancel/reset and query isolation ('+width+'px)',async()=>{
  const page=await browser.newPage({viewport:{width,height:800}});
  const errors=[],network=[];page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>network.push(r.url()));
  try {
    await page.setContent(html);await page.locator('#tabBtn-chat').click();
    assert.equal(await page.locator('#chat-send').isEnabled(),false);
    assert.match(await page.locator('#chat-placeholder').textContent(),/IntelliJ Password Safe/);
    assert.match(await page.locator('#chat-placeholder').textContent(),/once per dump-editor chat session/);
    assert.match(await page.locator('#chat-placeholder').textContent(),/Explain and Fix with AI ask separately/);
    await page.locator('#ai-configure').click();assert.equal((await latest(page)).command,'aiConfigure');
    assert.equal(await page.locator('#ai-configure').isEnabled(),false);
    await send(page,{command:'aiConfiguration',message:'Configured <test> provider'});
    assert.equal(await page.locator('#ai-configure').isEnabled(),true);
    await send(page,analysis);await page.locator('#chat-input').fill('Explain retained size');await page.locator('#chat-send').click();
    const first=await latest(page);assert.equal(first.command,'aiSend');assert.deepEqual(Object.keys(first).sort(),['command','requestId','text']);
    assert.match(await page.locator('#ai-status').textContent(),/approval will be requested if needed/);
    await send(page,{command:'aiError',requestId:first.requestId,message:'Cancelled before sending. No AI request was made.'});
    assert.match(await page.locator('#ai-status').textContent(),/No AI request/);
    await page.locator('#chat-input').fill('Suggest a query');await page.locator('#chat-input').press('Enter');const second=await latest(page);
    assert.notEqual(first.requestId,second.requestId);
    const answer='Retained memory can overlap.\n\n```heapql\nSELECT class_name FROM instances LIMIT 5\n```\n<img src=x onerror=alert(1)>\n[unsafe](javascript:alert(1))';
    await send(page,{command:'aiChunk',requestId:second.requestId,text:answer});
    assert.match(await page.locator('#chat-messages .assistant').last().textContent(),/Retained memory/);
    await send(page,{command:'aiDone',requestId:second.requestId});
    assert.equal(await page.locator('#chat-messages img, #chat-messages script, #chat-messages a[href^="javascript:"]').count(),0);
    assert.equal(await page.locator('#chat-messages .chat-run-query-btn').count(),1);
    assert.equal(await page.locator('#chat-send').isEnabled(),true);
    assert.equal(await page.evaluate(()=>window.sentMessages.some(m=>m.command==='executeQuery')),false);
    const sendBox=await page.locator('#chat-send').boundingBox();assert.ok(sendBox && sendBox.y>=0 && sendBox.y+sendBox.height<=800);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if(process.env.HEAPLENS_LAYOUT_EVIDENCE_DIR){fs.mkdirSync(process.env.HEAPLENS_LAYOUT_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.HEAPLENS_LAYOUT_EVIDENCE_DIR,'chat-'+width+'.png')});}
    await page.locator('#chat-input').fill('stop this');await page.locator('#chat-send').click();const stopped=await latest(page);
    await page.locator('#ai-stop').click();assert.equal((await latest(page)).command,'aiStop');
    await send(page,{command:'aiError',requestId:stopped.requestId,message:'Stopped. Provider may already have received request.'});
    await page.locator('#chat-input').fill('clear this');await page.locator('#chat-send').click();const cleared=await latest(page);
    await page.locator('#chat-clear').click();assert.equal((await latest(page)).command,'aiClear');
    await send(page,{command:'aiChunk',requestId:cleared.requestId,text:'STALE'});await send(page,{command:'aiDone',requestId:cleared.requestId});
    assert.equal(await page.locator('#chat-messages .chat-bubble').count(),0);
    await send(page,{command:'serverCrashed'});assert.equal(await page.locator('#chat-send').isEnabled(),false);
    await send(page,{command:'analysisProgress',stage:'loading',phase:1,totalPhases:4});await send(page,analysis);
    assert.equal(await page.locator('#chat-send').isEnabled(),true);
    await page.locator('#tabBtn-query').click();await page.locator('#query-input').fill('SELECT class_name FROM instances LIMIT 1');await page.locator('#query-run-btn').click();
    assert.equal((await latest(page)).command,'executeQuery');
    assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
  } finally {await page.close();}
});
