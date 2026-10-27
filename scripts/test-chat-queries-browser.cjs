// Actual shared/packaged host renderers in Chromium; deterministic replies, no live AI or telemetry.
'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.HEAPLENS_PLAYWRIGHT_MODULE||'playwright');
const load=(file,name)=>require('../out/webview/'+file)[name]();
const vscodeHtml='<!doctype html><html><head><style>'+load('styles','getStyles')+'</style></head><body>'+load('template','getHtmlTemplate')+
 '<script>window.sent=[];var analysisData=null,depInfoCache={};const vscode={postMessage:m=>window.sent.push(m)};'+load('js/registry','getRegistryJs')+load('js/helpers','getHelperJs')+load('js/chat','getChatJs')+load('js/query','getQueryJs')+'</script></body></html>';
const nativeHtml=fs.readFileSync(path.join(__dirname,'../intellij-plugin/build/generated/webview/webview/index.html'),'utf8').replaceAll('__NONCE__','query-test')
 .replace('__BRIDGE__','window.sent=(window.sent||[]).concat([message]);');
const browserHtml=fs.readFileSync(path.join(__dirname,'../browser-ui/build/index.html'),'utf8').replaceAll('__NONCE__','query-test')
 .replace(/<script nonce="query-test">[\s\S]*?<\/script>/,'<script nonce="query-test">window.sent=[];window.heaplensSend=m=>window.sent.push(m);</script>');
const analysis={command:'analysisComplete',summary:{total_heap_size:2048,reachable_heap_size:1024,total_instances:2,total_classes:1,total_arrays:0,total_gc_roots:1},topObjects:[],topLayers:[],classHistogram:[],leakSuspects:[]};
const query='SELECT object_id, class_name FROM instances LIMIT 5';
const formats=[...['heapql','HeapQL','sql','SQL',''].map(lang=>({name:lang||'untagged',text:'Suggestion:\n\n```'+lang+'\n'+query+'\n```',query})),
 {name:'plain',text:query,query},{name:'inline',text:'Try `'+query+'` to inspect the snapshot.',query},
 {name:'CRLF',text:'```sql\r\n'+query+'\r\n```',query},
 {name:'multiline',text:'SELECT object_id, class_name\nFROM instances\nLIMIT 5;',query:'SELECT object_id, class_name\nFROM instances\nLIMIT 5'},
 {name:'inspection',text:'```\n:refs 42\n```',query:':refs 42'}];
let browser;
before(async()=>{browser=await chromium.launch({headless:true,...(process.env.HEAPLENS_CHROMIUM_EXECUTABLE?{executablePath:process.env.HEAPLENS_CHROMIUM_EXECUTABLE}:{})});});
after(async()=>{await browser?.close();});
const send=(page,data)=>page.evaluate(data=>window.dispatchEvent(new MessageEvent('message',{data})),data);
const messages=page=>page.evaluate(()=>window.sent||[]);
const executions=async page=>(await messages(page)).filter(m=>m.command==='executeQuery'||m.command==='aiRunQuery');
async function reply(page,host,text){
 await page.locator('#chat-input').fill('Suggest a HeapQL query');await page.locator('#chat-send').click();
 const request=(await messages(page)).at(-1);assert.equal(request.command,host==='vscode'?'chatMessage':'aiSend');
 await send(page,{command:host==='vscode'?'chatChunk':'aiChunk',requestId:request.requestId,text});
 assert.equal(await page.locator('#chat-messages .assistant').last().locator('.chat-run-query-btn').count(),0,'No actions on partial output');
 await send(page,{command:host==='vscode'?'chatDone':'aiDone',requestId:request.requestId,safeEvidenceAnswer:true,evidence:[{id:'E000000000001_1',operation:'summary'}]});
}
function result(host,request,rows=[['LOCAL_ONLY_QUERY_RESULT']]){return {command:host==='vscode'?'chatQueryResult':'aiQueryResult',requestId:request.requestId,query:request.query,result:{columns:['class_name'],rows,execution_time_ms:1}};}
for(const [host,html] of [['vscode',vscodeHtml],['intellij',nativeHtml],['browser',browserHtml]]){
 test(host+': uncited replies have no evidence attachments; cited records stay local and deduplicated',async()=>{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
  try{await page.setContent(html);await send(page,analysis);await page.locator('#tabBtn-chat').click();
   for(const text of ['Hi! What would you like to inspect?',
    'I can help with heap analysis, not unrelated biographies.',
    'Amitabh Bachchan is an Indian actor.', // Even a disobedient provider reply must not gain unrelated heap evidence.
    'Retained size includes objects exclusively kept alive by an owner.']){
    await reply(page,host,text);const bubble=page.locator('#chat-messages .assistant').last();
    assert.equal(await bubble.getByRole('button',{name:/View evidence/}).count(),0);assert.doesNotMatch(await bubble.innerText(),/Evidence below|AI interpretation may be wrong/);
   }
   await page.locator('#chat-input').fill('Explain this heap and suggest a query');await page.locator('#chat-send').click();const request=(await messages(page)).at(-1);
   const text='The heap metadata is recorded here [E000000000001_1]. Again [E000000000001_1].\n\n```heapql\n'+query+'\n```';
   await send(page,{command:host==='vscode'?'chatChunk':'aiChunk',requestId:request.requestId,text});
   await send(page,{command:host==='vscode'?'chatDone':'aiDone',requestId:request.requestId,safeEvidenceAnswer:true,
    evidence:[{id:'E000000000001_1',operation:'summary'},{id:'E000000000001_1',operation:'summary'},{id:'E000000000001_2',operation:'object'},{id:'INVALID',operation:'object'}]});
   const bubble=page.locator('#chat-messages .assistant').last();assert.equal(await bubble.getByRole('button',{name:'View evidence: summary'}).count(),1);
   assert.equal(await bubble.getByRole('button',{name:'View evidence: object'}).count(),0);assert.match(await bubble.innerText(),/AI interpretation may be wrong/);
   assert.equal(await bubble.locator('.chat-run-query-btn').count(),1);assert.equal((await executions(page)).length,0);
   await bubble.getByRole('button',{name:'View evidence: summary'}).click();assert.deepEqual((await messages(page)).at(-1),{command:'openAiEvidence',id:'E000000000001_1'});
   assert.equal((await executions(page)).length,0);assert.deepEqual(errors,[]);
   if(process.env.HEAPLENS_QUERY_EVIDENCE_DIR){fs.mkdirSync(process.env.HEAPLENS_QUERY_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.HEAPLENS_QUERY_EVIDENCE_DIR,host+'-scope-evidence.png')});}
  }finally{await page.close();}
 });
 test(host+': query formats require a click, preserve exact text and keep results out of AI traffic',async()=>{
  const page=await browser.newPage({viewport:{width:1200,height:850}}),errors=[],network=[];
  page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>network.push(r.url()));
  try{await page.setContent(html);await send(page,analysis);await page.locator('#tabBtn-chat').click();
   for(const format of formats){
    const before=(await executions(page)).length;await reply(page,host,format.text);
    const bubble=page.locator('#chat-messages .assistant').last(),button=bubble.locator('.chat-run-query-btn');assert.equal(await button.count(),1,format.name);
    assert.equal((await executions(page)).length,before,'Displaying '+format.name+' must not execute');
    await page.locator('#query-input').evaluate(input=>{input.value='KEEP QUERY TAB';});await button.click();
    const request=(await executions(page)).at(-1);assert.equal(request.command,host==='vscode'?'executeQuery':'aiRunQuery');assert.equal(request.query,format.query,format.name);assert.ok(request.requestId);
    assert.equal(await button.isDisabled(),true);
    await send(page,{...result(host,request),requestId:'wrong-id'});assert.doesNotMatch(await bubble.innerText(),/LOCAL_ONLY_QUERY_RESULT/);
    await send(page,result(host,request));assert.match(await bubble.innerText(),/LOCAL_ONLY_QUERY_RESULT/);assert.equal(await button.isEnabled(),true);
    assert.equal(await page.locator('#query-input').inputValue(),'KEEP QUERY TAB');
    assert.equal((await executions(page)).length,before+1);assert.doesNotMatch(JSON.stringify(await messages(page)),/LOCAL_ONLY_QUERY_RESULT/);
    if(process.env.HEAPLENS_QUERY_EVIDENCE_DIR && ['sql','untagged','plain'].includes(format.name)){fs.mkdirSync(process.env.HEAPLENS_QUERY_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.HEAPLENS_QUERY_EVIDENCE_DIR,host+'-'+format.name+'.png')});}
   }
   for(const text of ['```java\n'+query+'\n```','```bash\n'+query+'\n```','```sql\nDELETE FROM instances\n```','SELECT * FROM objects','```sql\n'+query+'; DROP TABLE instances\n```']){
    await reply(page,host,text);assert.equal(await page.locator('#chat-messages .assistant').last().locator('.chat-run-query-btn').count(),0,text);
   }
   assert.equal(await page.locator('#chat-messages img,#chat-messages script').count(),0);assert.deepEqual(network,[]);assert.deepEqual(errors,[]);
  }finally{await page.close();}
 });
 test(host+': errors re-enable Run Query; multiple queries, full results and Retry stay isolated',async()=>{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
  try{await page.setContent(html);await send(page,analysis);await page.locator('#tabBtn-chat').click();
   await reply(page,host,'```sql\n'+query+'\n```\n\n```\nSELECT COUNT(*) FROM instances\n```');
   const bubble=page.locator('#chat-messages .assistant').last(),buttons=bubble.locator('.chat-run-query-btn');assert.equal(await buttons.count(),2);
   await buttons.first().click();let request=(await executions(page)).at(-1);assert.equal(await buttons.nth(1).isDisabled(),true);
   await send(page,{command:host==='vscode'?'chatQueryError':'aiQueryError',requestId:request.requestId,error:'Invalid query <img src=x onerror=alert(1)>'});
   assert.equal(await buttons.first().isEnabled(),true);assert.equal(await buttons.nth(1).isEnabled(),true);assert.equal(await page.locator('img').count(),0);
   await buttons.first().click();request=(await executions(page)).at(-1);await send(page,result(host,request,Array.from({length:51},(_,i)=>['Row'+i])));
   const before=(await executions(page)).length;await bubble.locator('.chat-query-link').click();assert.equal((await executions(page)).length,before+1,'Full results link executes once, on click');
   const full=(await executions(page)).at(-1);assert.equal(full.command,'executeQuery');assert.equal(full.query,query);
   await page.locator('#tabBtn-chat').click();await buttons.nth(1).click();request=(await executions(page)).at(-1);
   await send(page,result(host,request,[['SECOND_QUERY_ONLY']]));assert.match(await bubble.innerText(),/Row0/,'Running a second suggestion must preserve the first result');assert.match(await bubble.innerText(),/SECOND_QUERY_ONLY/);
   await buttons.nth(1).click();request=(await executions(page)).at(-1);
   const count=(await executions(page)).length;await send(page,{command:'analysisProgress',stage:'loading',phase:1,totalPhases:4});await send(page,analysis);
   await send(page,result(host,request));assert.doesNotMatch(await page.locator('#chat-messages').innerText(),/LOCAL_ONLY_QUERY_RESULT/);
   if(host==='vscode')assert.equal(await buttons.nth(1).isDisabled(),true);else assert.equal(await buttons.count(),0);
   assert.equal((await executions(page)).length,count);assert.deepEqual(errors,[]);
  }finally{await page.close();}
 });
}
