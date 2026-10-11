const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('build/generated/webview/webview/index.html', 'utf8');

test('native telemetry consent is requested only for an active created editor',()=>{
  const editor=fs.readFileSync('src/main/java/com/heaplens/intellij/HeapEditor.java','utf8');
  assert.match(editor,/requestConsent\(project,\(\)->!disposed\)/);
  const created=editor.indexOf('browser = views.create(');
  assert.ok(created>=0,'Recheck the native browser factory boundary if it changes');
  assert.ok(editor.indexOf('requestConsent(')>created);
  const host=fs.readFileSync('src/main/java/com/heaplens/intellij/IntellijTelemetry.java','utf8');
  assert.match(host,/if\(!permission.beginPrompt\(\)\)return/);
  assert.match(host,/invokeLater/);
  assert.match(host,/if\(!permission.promptPending\(\)\)return/);
  assert.match(host,/!active.getAsBoolean\(\)/);
  assert.match(host,/"No Telemetry"\},2/);
});

// JCEF does not inject VS Code's theme variables. A missing surface color makes
// sticky headers transparent even when their stacking order is correct.
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');
const themeTokens = new Map([...css.matchAll(/(--vscode-[\w-]+)\s*:\s*([^;]+);/g)]
  .map(([, name, value]) => [name, value.trim()]));
for (const [surface, selector, token] of [
  ['tab strip', '.tab-bar', '--vscode-editorGroupHeader-tabsBackground'],
  ['table header', 'th', '--vscode-editorWidget-background'],
  ['hovered table header', 'th:hover', '--vscode-list-hoverBackground']
]) {
  test('IntelliJ supplies an opaque background for the shared ' + surface, () => {
    const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .find(([, selectors]) => selectors.trim() === selector);
    assert.ok(rule, 'Missing shared rule: ' + selector);
    assert.ok(rule[2].includes('background: var(' + token + ')'),
      'Recheck the host theme contract when the shared surface changes');
    // The prototype deliberately uses six-digit opaque colors, not alpha colors.
    assert.match(themeTokens.get(token) || '', /^#[0-9a-f]{6}$/i,
      'Missing opaque host color: ' + token);
  });
}

function lastRule(selector) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => selectors.trim() === selector).at(-1)?.[2] || '';
}
test('IntelliJ keeps navigation outside the active scrolling pane', () => {
  assert.match(lastRule('body'), /display:\s*flex\s*;/);
  assert.match(lastRule('body'), /flex-direction:\s*column\s*;/);
  assert.match(lastRule('body'), /height:\s*100vh\s*;/);
  assert.match(lastRule('body'), /overflow:\s*hidden\s*;/);
  assert.match(lastRule('.tab-bar'), /position:\s*relative\s*;/);
  assert.match(lastRule('.tab-content.active'), /flex:\s*1\s*;/);
  assert.match(lastRule('.tab-content.active'), /min-height:\s*0\s*;/);
  assert.match(lastRule('.tab-content.active'), /overflow:\s*auto\s*;/);
  assert.match(lastRule('.tab-content.active'), /padding-top:\s*0\s*;/);
  assert.match(lastRule('.tab-content.active::before'), /height:\s*var\(--hl-space-lg\)\s*;/);
});
test('IntelliJ Overview headers stick to the pane edge without a guessed tab height', () => {
  assert.match(lastRule('#tab-overview th'), /top:\s*0\s*;/);
});
test('IntelliJ explanatory paragraphs use the host text size, not the browser default', () => {
  assert.match(lastRule(':where(.tab-content > p, .timeline-controls > p, .monitor-histogram-section > p, #source-status)'),
    /font-size:\s*var\(--vscode-font-size,\s*13px\)\s*;/);
  assert.doesNotMatch(lastRule('body'), /font-size\s*:/,
    'The paragraph fix must not resize every inherited control and heading');
});
test('native appearance initializes before load and subscribes with browser-owned disposal',()=>{
  const native=fs.readFileSync('src/main/java/com/heaplens/intellij/HeapBrowser.java','utf8');
  assert.match(native,/HeapAppearance.initialCss\(\)/);
  assert.match(native,/getMessageBus\(\).connect\(this\)/);
  assert.match(native,/subscribe\(LafManagerListener.TOPIC/);
  assert.match(native,/"ready"\.equals/);
  assert.match(css,/::-webkit-scrollbar-thumb/);
  assert.match(lastRule('.tab-content.active, .query-results, .inspector-panel'),/scrollbar-gutter:\s*stable/);
});

// DOM contract harness, not a claim of native JCEF layout/accessibility coverage.
function harness() {
  function decode(value) {
    return value.replaceAll('&quot;', '"').replaceAll('&#39;', "'")
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  }
  class Element {
    constructor() {
      this.listeners = {}; this.dataset = {}; this.style = {}; this.value = '';
      this.attributes = {}; this.tagName = '';
      this.innerHTML = ''; this.disabled = false; this.classList = {add(){},remove(){}};
    }
    set innerHTML(v) {
      this._html = String(v); this.children = [];
      // Flatten only the generated controls used by these contract tests.
      // This deliberately does not simulate browser layout or full DOM parsing.
      for (const [, tag, attrs] of this._html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
        const child = new Element(); child.tagName = tag.toLowerCase();
        for (const [, name, value] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(name, decode(value));
        this.children.push(child);
      }
    }
    get innerHTML() { return this._html; }
    set textContent(v) { this.innerHTML = String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
    get textContent() { return this.innerHTML; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    querySelectorAll(selector) {
      const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
      const classes = [...selector.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
      const attr = selector.match(/\[([\w-]+)\]/)?.[1];
      return this.children.filter(el => (!tag || el.tagName === tag)
        && classes.every(c => (el.className || '').split(' ').includes(c))
        && (!attr || attr in el.attributes));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(name, value) {
      this.attributes[name] = value;
      if (name.startsWith('data-')) this.dataset[name.slice(5)] = value;
      if (name === 'class') this.className = value;
    }
    getAttribute(name) { return this.attributes[name]; }
    focus() {}
    remove() { this.removed = true; }
    click() { this.listeners.click?.({}); }
  }
  // Do not treat IDs in renderer JavaScript strings as existing DOM elements.
  // Dynamic controls must be discovered from the generated panel contents.
  const markup = html.slice(0, html.indexOf('<script'));
  const elements = new Map([...markup.matchAll(/\bid="([^"]+)"/g)].map(m => [m[1], new Element()]));
  for (const id of ['progress-cancel-btn','progress-retry-btn']) elements.set(id,new Element());
  const tabs = [...markup.matchAll(/<button[^>]*class="tab-btn[^"]*"[^>]*data-tab="([^"]+)"/g)].map(m => {
    const el = new Element(); el.dataset.tab = m[1]; return el;
  });
  const window = new Element(), messages = [];
  const document = {
    getElementById(id) {
      return elements.get(id) || [...elements.values()].flatMap(el => el.children).find(el => el.attributes.id === id) || null;
    },
    querySelectorAll(selector) { return selector === '.tab-btn' ? tabs.filter(t=>!t.removed) : []; },
    querySelector(selector) { return selector === '.tab-content.active' ? null : new Element(); }, createElement() { return new Element(); },
    addEventListener() {}
  };
  const scripts = [...html.matchAll(/<script nonce="__NONCE__">([\s\S]*?)<\/script>/g)];
  const context = vm.createContext({
    window, document, messages, setTimeout, clearTimeout, console
  });
  vm.runInContext(scripts.at(-1)[1].replace('__BRIDGE__','messages.push(message)')
    .replace('function dispatchHost(message)', 'window.testDispatch = dispatchHost; function dispatchHost(message)'), context);
  return {elements,tabs,messages, send: data=>window.listeners.message({data}),
    action: message=>window.testDispatch(message) };
}
test('object actions strip page context, correlate replies and cancel an abandoned explanation',()=>{
  const h=harness();complete(h);
  h.action({command:'explainObject',objectId:42,fields:'PRIVATE_FIELDS',source:'PRIVATE_SOURCE'});
  const explain=h.messages.at(-1);
  assert.deepEqual(Object.keys(explain).sort(),['command','objectId','requestId']);
  assert.equal(h.elements.get('local-action-stop').disabled,false);
  h.action({command:'inspectObject',objectId:43});
  assert.equal(h.messages.at(-2).command,'cancelAiAssistance');
  assert.equal(h.messages.at(-1).command,'inspectObject');
  h.send({...explain,command:'explainError',message:'stale error'});
  assert.doesNotMatch(h.elements.get('local-action-status').textContent,/stale/);
  h.send({command:'serverCrashed'});
  const count=h.messages.length;h.action({command:'inspectObject',objectId:42});assert.equal(h.messages.length,count);
});
test('object requests reject lossy IDs and AI requests cannot overlap or submit page source',()=>{
  const h=harness();complete(h);const initial=h.messages.length;
  for(const objectId of [-1,0,1.5,Number.MAX_SAFE_INTEGER+1,'42'])h.action({command:'inspectObject',objectId});
  assert.equal(h.messages.length,initial);
  h.action({command:'fixWithAi',className:'example.Owner',path:'/private/source',source:'SECRET'});
  const request=h.messages.at(-1);assert.deepEqual(Object.keys(request).sort(),['className','command','requestId']);
  h.action({command:'fixWithAi',className:'example.Owner'});assert.equal(h.messages.at(-1),request);
  assert.match(h.elements.get('local-action-status').textContent,/already running/);
  h.send({...request,command:'fixAiResult',message:'Cancelled'});
  assert.equal(h.elements.get('local-action-stop').disabled,true);
  assert.equal(h.elements.get('local-action-stop').hidden,true);
  h.action({command:'fixWithAi',className:'example.Other'});assert.notEqual(h.messages.at(-1).requestId,request.requestId);
});
test('idle AI Stop stays hidden with terminal status and Dismiss does not cancel work',()=>{
  const h=harness();complete(h);
  h.action({command:'fixWithAi',className:'example.Owner'});const request=h.messages.at(-1);
  assert.equal(h.elements.get('local-action-stop').hidden,false);
  h.send({...request,command:'fixAiResult',message:'Cancelled before sending.'});
  assert.equal(h.elements.get('local-action-stop').hidden,true);
  assert.match(h.elements.get('local-action-status').textContent,/Cancelled/);
  const count=h.messages.length;h.elements.get('local-action-dismiss').click();
  assert.equal(h.messages.length,count);assert.equal(h.elements.get('local-action-bar').hidden,true);
});
test('generated UI boots, posts ready and exposes all eleven implemented tabs',()=>{
  const h=harness();
  assert.equal(h.messages[0].command,'ready');
  assert.deepEqual(h.tabs.filter(t=>!t.removed).map(t=>t.dataset.tab),['overview','histogram','domtree','leaks','waste','source','query','compare','timeline','monitor','chat']);
});
test('same Overview and query renderers consume translated engine DTOs safely',()=>{
  const h=harness();
  h.send({command:'analysisComplete',summary:{total_heap_size:1024,reachable_heap_size:512,total_instances:3,total_classes:2,total_arrays:1,total_gc_roots:1},topObjects:[],classHistogram:[]});
  assert.match(h.elements.get('stats-bar').innerHTML,/512 B/);
  h.elements.get('query-input').value='SELECT class_name FROM instances';
  h.elements.get('query-run-btn').click();
  assert.equal(h.messages.at(-1).command,'executeQuery');
  h.send({command:'queryResult',query:'SELECT class_name FROM instances',result:{columns:['class_name'],rows:[['<img src=x onerror=alert(1)>']],total_scanned:1,total_matched:1,execution_time_ms:1}});
  assert.match(h.elements.get('query-results').innerHTML,/&lt;img/);
  assert.doesNotMatch(h.elements.get('query-results').innerHTML,/<img/);
  assert.equal(h.elements.get('query-run-btn').disabled,false);
});
test('cancellation renders Retry and crash releases the disabled query button',()=>{
  const h=harness();
  h.send({command:'analysisCancelled'});
  assert.match(h.elements.get('progress-bar').innerHTML,/Retry/);
  h.elements.get('progress-retry-btn').click();
  assert.equal(h.messages.at(-1).command,'retryAnalysis');
  h.elements.get('query-run-btn').disabled=true;
  h.send({command:'serverCrashed'});
  assert.equal(h.elements.get('query-run-btn').disabled,false);
  assert.match(h.elements.get('progress-bar').innerHTML,/Retry/);
});
function complete(h) {
  h.send({command:'analysisComplete',summary:{total_heap_size:1024,reachable_heap_size:512,total_instances:3,total_classes:2,total_arrays:1,total_gc_roots:1},topObjects:[],classHistogram:[]});
}
function loading(h) { h.send({command:'analysisProgress',stage:'loading',phase:1,totalPhases:4}); }
for (const activeTab of ['query','overview']) {
  test('successful Retry clears the Query crash warning before another query, active tab '+activeTab,()=>{
    const h=harness(), query='SELECT class_name FROM instances LIMIT 1';
    complete(h);
    h.send({command:'queryResult',query,result:{columns:['class_name'],rows:[['Example']],total_matched:1}});
    h.tabs.find(t=>t.dataset.tab===activeTab).click();
    const status=h.elements.get('query-status'), input=h.elements.get('query-input');
    const history=h.elements.get('query-history').children.map(el=>el.textContent);
    h.send({command:'serverCrashed'});
    assert.equal(status.className,'query-status error');
    loading(h);
    assert.equal(status.className,'query-status');
    assert.match(status.textContent,/Reanalyzing/);
    complete(h);
    h.tabs.find(t=>t.dataset.tab==='query').click();
    assert.equal(status.className,'query-status');
    assert.equal(status.textContent,'');
    assert.equal(h.elements.get('query-results').innerHTML,'');
    assert.equal(input.value,query);
    assert.deepEqual(h.elements.get('query-history').children.map(el=>el.textContent),history);
    assert.equal(h.elements.get('progress-bar').style.display,'none');
    h.elements.get('query-run-btn').click();
    assert.equal(h.messages.at(-1).command,'executeQuery');
    h.send({command:'queryResult',query,result:{columns:['class_name'],rows:[['Recovered']],total_matched:1}});
    assert.match(h.elements.get('query-results').innerHTML,/Recovered/);
    assert.equal(h.elements.get('query-run-btn').disabled,false);
  });
}
test('a failed Retry keeps its error visible and a later successful Retry clears it',()=>{
  const h=harness(), status=h.elements.get('query-status');
  // Includes a server failure before the first successful analysis.
  h.send({command:'serverCrashed'});
  loading(h);
  h.send({command:'serverCrashed'});
  assert.equal(status.className,'query-status error');
  assert.match(status.textContent,/unavailable/);
  assert.match(h.elements.get('progress-bar').innerHTML,/Retry/);
  loading(h);
  complete(h);
  assert.equal(status.className,'query-status');
  assert.equal(status.textContent,'');
});
test('cancelling recovery does not leave a reanalyzing status and a later Retry can recover',()=>{
  const h=harness(), status=h.elements.get('query-status');
  complete(h);
  h.send({command:'serverCrashed'});
  loading(h);
  h.send({command:'analysisCancelled'});
  assert.equal(status.className,'query-status');
  assert.match(status.textContent,/cancelled/);
  assert.doesNotMatch(status.textContent,/Reanalyzing/);
  loading(h);
  complete(h);
  assert.equal(status.textContent,'');
});
test('query errors unrelated to server recovery are not silently cleared',()=>{
  for (const previouslyRecovered of [false,true]) {
    const h=harness(), status=h.elements.get('query-status');
    complete(h);
    if (previouslyRecovered) {
      h.send({command:'serverCrashed'});
      loading(h);
      complete(h);
    }
    h.send({command:'queryError',query:'bad SQL',error:'Invalid syntax'});
    complete(h);
    assert.equal(status.className,'query-status error');
    assert.match(status.textContent,/Invalid syntax/);
  }
});
test('prototype CSP denies page network calls while host-backed object actions are exposed',()=>{
  assert.match(html,/connect-src 'none'/);
  assert.equal(html.includes('#report-actions, .why-alive-btn { display:none!important'),false);
  assert.doesNotMatch(html,/<script[^>]+src="https?:/);
});

test('AI commands never contain settings or credentials and require analyzed state',()=>{
  const h=harness();
  assert.equal(h.elements.get('chat-send').disabled,true);
  h.elements.get('ai-configure').click();
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages.at(-1))),{command:'aiConfigure'});
  h.send({command:'aiConfiguration',message:'Configured test provider'});complete(h);
  h.elements.get('chat-input').value='What retains memory?';h.elements.get('chat-send').click();
  const request=h.messages.at(-1);
  assert.deepEqual(Object.keys(request).sort(),['command','requestId','text']);assert.equal(request.command,'aiSend');
  assert.equal(h.elements.get('ai-stop').disabled,false);
  h.send({command:'aiError',requestId:'wrong',message:'STALE'});
  assert.doesNotMatch(h.elements.get('ai-status').textContent,/STALE/);
  h.send({command:'aiError',requestId:request.requestId,message:'Cancelled before sending.'});
  assert.equal(h.elements.get('chat-send').disabled,false);
  assert.match(h.elements.get('ai-status').textContent,/Cancelled/);
});
test('AI Clear and unavailable states retire replies and cannot affect Query',()=>{
  const h=harness();complete(h);
  h.elements.get('query-status').textContent='independent';
  h.elements.get('chat-input').value='question';h.elements.get('chat-send').click();const request=h.messages.at(-1);
  h.elements.get('ai-stop').click();assert.equal(h.messages.at(-1).command,'aiStop');
  h.elements.get('chat-clear').click();assert.equal(h.messages.at(-1).command,'aiClear');
  for(const command of ['aiChunk','aiDone','aiError']) h.send({command,requestId:request.requestId,text:'late',message:'late'});
  assert.match(h.elements.get('ai-status').textContent,/cleared/);
  assert.equal(h.elements.get('query-status').textContent,'independent');
  h.send({command:'serverCrashed'});assert.equal(h.elements.get('chat-send').disabled,true);
  loading(h);complete(h);assert.equal(h.elements.get('chat-send').disabled,false);
  assert.equal(h.elements.get('chat-input').getAttribute('maxlength'),'4000');
});

const sampleClasses = [
  {class_name:'example.A',instance_count:2,shallow_size:32,retained_size:80},
  {class_name:'example.B',instance_count:1,shallow_size:24,retained_size:120}
];
function histogram(h, classes = sampleClasses) {
  h.send({command:'analysisComplete',summary:{total_heap_size:1024,reachable_heap_size:512,
    total_instances:3,total_classes:2,total_arrays:1,total_gc_roots:1},
    topObjects:[],classHistogram:classes});
  h.tabs.find(t=>t.dataset.tab==='histogram').click();
}
function selectClass(h, name) {
  const link = h.elements.get('histogram-table').querySelectorAll('.hist-class-link').find(el=>el.dataset.class===name);
  assert.ok(link, 'Class link missing: '+name);
  link.click();
  return h.messages.at(-1);
}
function instances(h, request, rows = [[7,'example.A',16,80]]) {
  h.send({...request,
    command:'histogramInstancesResult',
    result:{columns:['object_id','class_name','shallow_size','retained_size'],rows,total_count:rows.length}});
}
function percentages(h) {
  return [...h.elements.get('histogram-table').innerHTML.matchAll(/<tr><td>(.*?)<\/tr>/g)]
    .map(row => [...row[0].matchAll(/<td[^>]*>(.*?)<\/td>/g)].at(-1)[1]);
}
test('Histogram uses the shared reachable-heap percentage with the tab already active',()=>{
  const h=harness();
  h.tabs.find(t=>t.dataset.tab==='histogram').click();
  histogram(h);
  assert.deepEqual(percentages(h),['23.4%','15.6%']);
  const table=h.elements.get('histogram-table'), input=h.elements.get('histogram-search');
  table.querySelectorAll('th[data-sort]').find(el=>el.dataset.sort==='heap_pct').click();
  table.querySelectorAll('th[data-sort]').find(el=>el.dataset.sort==='heap_pct').click();
  assert.deepEqual(percentages(h),['15.6%','23.4%']);
  input.value='example.A'; input.listeners.input({target:input});
  assert.deepEqual(percentages(h),['15.6%']);
  assert.match(table.innerHTML,/Percentages use reachable heap/);
});
test('Histogram has no total-heap fallback for missing or invalid reachable heap',()=>{
  for (const reachable of [undefined,0,-1,NaN,Infinity,'512']) {
    const h=harness();
    h.tabs.find(t=>t.dataset.tab==='histogram').click();
    h.send({command:'analysisComplete',summary:{total_heap_size:1024,reachable_heap_size:reachable,
      total_instances:3,total_classes:2,total_arrays:1,total_gc_roots:1},
      topObjects:[],classHistogram:sampleClasses});
    assert.deepEqual(percentages(h),['N/A','N/A']);
    const input=h.elements.get('histogram-search');
    input.value='example.A'; input.listeners.input({target:input});
    assert.deepEqual(percentages(h),['N/A']);
  }
});
test('Histogram percentages belong to each editor and use the new summary after Retry',()=>{
  const first=harness(), second=harness();
  histogram(first); histogram(second);
  first.send({command:'serverCrashed'}); loading(first);
  first.send({command:'analysisComplete',summary:{total_heap_size:2000,reachable_heap_size:1000,
    total_instances:3,total_classes:2,total_arrays:1,total_gc_roots:1},
    topObjects:[],classHistogram:sampleClasses});
  assert.deepEqual(percentages(first),['12.0%','8.0%']);
  assert.deepEqual(percentages(second),['23.4%','15.6%']);
});
test('Histogram lazily reuses sorting, filtering and bounded class rendering',()=>{
  const h=harness(), table=h.elements.get('histogram-table');
  complete(h); assert.equal(table.innerHTML,'');
  const classes=Array.from({length:205},(_,i)=>({class_name:'example.Class'+i,instance_count:i+1,shallow_size:16,retained_size:i}));
  // A new analysis invalidates the shared lazy-render cache.
  loading(h); histogram(h,classes);
  assert.equal(table.querySelectorAll('.hist-class-link').length,200);
  table.children.find(el=>el.attributes.id==='show-all-histogram').click();
  assert.equal(table.querySelectorAll('.hist-class-link').length,205);
  assert.equal(percentages(h)[0],'39.8%');
  table.querySelectorAll('th[data-sort]').find(el=>el.dataset.sort==='instance_count').click();
  assert.equal(table.querySelectorAll('.hist-class-link')[0].dataset.class,'example.Class204');
  table.querySelectorAll('th[data-sort]').find(el=>el.dataset.sort==='instance_count').click();
  assert.equal(table.querySelectorAll('.hist-class-link')[0].dataset.class,'example.Class0');
  const input=h.elements.get('histogram-search'); input.value='CLASS204';
  input.listeners.input({target:input});
  assert.equal(table.querySelectorAll('.hist-class-link').length,1);
  input.value='no match'; input.listeners.input({target:input});
  assert.equal(table.querySelectorAll('.hist-class-link').length,0);
});
test('Histogram drill-down is correlated and cannot overwrite Query state',()=>{
  const h=harness(); histogram(h);
  h.elements.get('query-input').value='my query';
  const request=selectClass(h,'example.A');
  assert.equal(request.command,'histogramInstances'); assert.equal(request.className,'example.A');
  assert.equal(request.query,undefined);
  const panel=h.elements.get('histogram-instances-panel');
  h.send({command:'queryResult',query:'SELECT 1',result:{columns:['n'],rows:[[1]]}});
  assert.match(panel.innerHTML,/Loading instances/);
  instances(h,{...request,requestId:'wrong'});
  assert.match(panel.innerHTML,/Loading instances/);
  instances(h,request);
  assert.doesNotMatch(panel.innerHTML,/Loading instances/);
  assert.match(panel.innerHTML,/Instances of example.A/);
  assert.equal(h.elements.get('query-input').value,'SELECT 1');
  assert.match(h.elements.get('query-results').innerHTML,/>1</);
  assert.ok(panel.children.some(el=>el.textContent.includes('up to 200')));
});
test('rapid class changes ignore older replies and targeted errors do not affect Query',()=>{
  const h=harness(); histogram(h);
  const a=selectClass(h,'example.A'), b=selectClass(h,'example.B');
  instances(h,a); assert.match(h.elements.get('histogram-instances-panel').innerHTML,/Loading instances of example.B/);
  h.send({command:'histogramInstancesError',requestId:b.requestId,className:b.className,error:'Wait for previous query'});
  assert.match(h.elements.get('histogram-instances-panel').textContent,/Wait for previous query/);
  assert.equal(h.elements.get('query-status').textContent,'');
  instances(h,a);
  assert.match(h.elements.get('histogram-instances-panel').textContent,/Wait for previous query/);
  const retry=selectClass(h,'example.B'); instances(h,retry,[]);
  assert.match(h.elements.get('histogram-instances-panel').innerHTML,/No instances found/);
});
test('Histogram invalidates previews across crash, cancellation and reanalysis',()=>{
  const h=harness(); histogram(h);
  const old=selectClass(h,'example.A');
  h.send({command:'serverCrashed'});
  assert.equal(h.elements.get('histogram-search').disabled,true);
  assert.match(h.elements.get('histogram-table').textContent,/unavailable/);
  instances(h,old); assert.equal(h.elements.get('histogram-instances-panel').textContent,'');
  loading(h); h.send({command:'analysisCancelled'});
  assert.match(h.elements.get('histogram-table').textContent,/cancelled/);
  loading(h); histogram(h);
  assert.equal(h.elements.get('histogram-search').disabled,false);
  const current=selectClass(h,'example.A'); assert.notEqual(current.requestId,old.requestId);
  instances(h,old); assert.match(h.elements.get('histogram-instances-panel').textContent,/Loading/);
  instances(h,current);
  assert.match(h.elements.get('histogram-instances-panel').textContent,/Instances of/);
});
test('malformed instance results recover and class names and errors remain text',()=>{
  const h=harness(), name='<img src=x onerror=alert(1)>';
  histogram(h,[{class_name:name,instance_count:1,shallow_size:16,retained_size:16}]);
  assert.doesNotMatch(h.elements.get('histogram-table').innerHTML,/<img/);
  const request=selectClass(h,name);
  h.send({...request,command:'histogramInstancesResult',result:{rows:null,columns:[]}});
  assert.match(h.elements.get('histogram-instances-panel').textContent,/Invalid instance response/);
  const retry=selectClass(h,name);
  h.send({...retry,command:'histogramInstancesError',error:name});
  assert.doesNotMatch(h.elements.get('histogram-instances-panel').innerHTML,/<img/);
});
test('closing an instance panel does not let a duplicate reply reopen it',()=>{
  const h=harness(); histogram(h);
  const request=selectClass(h,'example.A'); instances(h,request);
  const panel=h.elements.get('histogram-instances-panel');
  panel.querySelector('.instance-panel-close').click();
  instances(h,request);
  assert.equal(panel.innerHTML,'');
});
test('Histogram exports shared CSV through the host without permitting an output path',()=>{
  const h=harness(); histogram(h);
  const table=h.elements.get('histogram-table'), count=h.messages.length;
  table.children.find(el=>el.attributes.id==='export-csv-btn').click();
  assert.equal(h.messages.length,count+1);
  assert.equal(h.messages.at(-1).command,'exportHistogramCsv');
  assert.deepEqual(Object.keys(h.messages.at(-1)).sort(),['command','csv']);
  assert.match(h.messages.at(-1).csv,/example.A/);
  assert.doesNotMatch(css,/#histogram-table (?:th|td):nth-child\(5\)/);
  assert.match(lastRule('#tab-histogram th'), /top:\s*0\s*;/);
});
