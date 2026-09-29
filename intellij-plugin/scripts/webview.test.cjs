const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('build/generated/webview/webview/index.html', 'utf8');

// DOM contract harness, not a claim of native JCEF layout/accessibility coverage.
function harness() {
  class Element {
    constructor() {
      this.listeners = {}; this.dataset = {}; this.style = {}; this.value = '';
      this.innerHTML = ''; this.disabled = false; this.classList = {add(){},remove(){}};
    }
    set innerHTML(v) { this._html = String(v); this.children = []; }
    get innerHTML() { return this._html; }
    set textContent(v) { this.innerHTML = String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
    get textContent() { return this.innerHTML; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    querySelectorAll() { return []; }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute() {}
    focus() {}
    remove() { this.removed = true; }
    click() { this.listeners.click?.({}); }
  }
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(m => [m[1], new Element()]));
  for (const id of ['progress-cancel-btn','progress-retry-btn']) elements.set(id,new Element());
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map(m => {
    const el = new Element(); el.dataset.tab = m[1]; return el;
  });
  const window = new Element(), messages = [];
  const document = {
    getElementById(id) { assert.ok(elements.has(id), 'Missing template element: '+id); return elements.get(id); },
    querySelectorAll(selector) { return selector === '.tab-btn' ? tabs.filter(t=>!t.removed) : []; },
    querySelector() { return new Element(); }, createElement() { return new Element(); },
    addEventListener() {}
  };
  const scripts = [...html.matchAll(/<script nonce="__NONCE__">([\s\S]*?)<\/script>/g)];
  vm.runInNewContext(scripts.at(-1)[1].replace('__BRIDGE__','messages.push(message)'), {
    window, document, messages, setTimeout, clearTimeout, console
  });
  return {elements,tabs,messages, send: data=>window.listeners.message({data})};
}
test('generated UI boots, posts ready and exposes only the two implemented tabs',()=>{
  const h=harness();
  assert.equal(h.messages[0].command,'ready');
  assert.deepEqual(h.tabs.filter(t=>!t.removed).map(t=>t.dataset.tab),['overview','query']);
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
test('prototype CSP denies network calls and unavailable actions remain hidden',()=>{
  assert.match(html,/connect-src 'none'/);
  assert.match(html,/#report-actions, .why-alive-btn \{ display:none!important/);
  assert.doesNotMatch(html,/<script[^>]+src="https?:/);
});
