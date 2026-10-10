const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const adapter = fs.readFileSync(path.join(__dirname,'../src/main/webview/source-adapter.js'),'utf8');
function harness() {
  const elements = new Map();
  for(const id of ['source-table','source-search','source-status','source-stats']) elements.set(id,{textContent:'',rows:[],disabled:false});
  elements.get('source-table').querySelectorAll = function(selector) { return selector === 'tr[data-source-class]' ? this.rows : []; };
  const listeners = {}, sent = [];
  const context = vm.createContext({document:{getElementById:id=>elements.get(id)},
    listen:(name,handler)=>listeners[name]=handler,send:message=>sent.push(message),
    _srcStatusMap:{},_srcHistogram:[],_srcFilter:'',_srcSortCol:'retained_size',_srcSortAsc:false,_tabRendered:{},
    renderSourceTab(){}, renderSourceTable(){
      elements.get('source-table').rows = context._srcHistogram.map(entry=>{
        const row={dataset:{sourceClass:entry.class_name},cells:Array.from({length:5},()=>({textContent:''}))};
        const button=()=>({disabled:false,textContent:'',addEventListener(name,fn){this[name]=fn;},cloneNode(){return button();},replaceWith(next){row.button=next;}});
        row.button=button(); row.querySelector=()=>row.button; row.querySelectorAll=()=>row.cells;
        return row;
      });
    }});
  vm.runInContext(adapter,context);
  return {context,elements,sent,send:(name,event={})=>listeners[name]?.(event),
    rows:()=>elements.get('source-table').rows};
}
const entries = [{class_name:'example.Owner$Inner',instance_count:1,retained_size:128},
  {class_name:'example.Other',instance_count:1,retained_size:64}];
test('native AI Fix resolves project-only metadata without opening or reading the file before consent',()=>{
  const native=fs.readFileSync(path.join(__dirname,'../src/main/java/com/heaplens/intellij/IntellijAiSource.java'),'utf8');
  const selection=native.slice(native.indexOf('public void select('),native.indexOf('public void confirm('));
  assert.match(selection,/navigator\.select\(target,true,active/);
  for(const check of ['isInLocalFileSystem()','isInContent(file)','file.isWritable()','target.matchesPath(file.getPath())','file.getLength()<=ReviewedProposal.MAX_CHARS'])
    assert.ok(selection.includes(check),check);
  assert.doesNotMatch(selection,/openFile|getDocument|getText|readApproved|loadText/);
  assert.doesNotMatch(adapter,/recordSourceCapability|sourceCapabilities/);
});
test('Source class screening excludes paths and accepts library and nested Unicode Java names',()=>{
  const {context}=harness();
  for(const name of ['example.Owner$Inner','example.Owner[][]','class example.Owner','例.Café','constructor','__proto__','java.lang.String'])
    assert.equal(context.isProjectSourceClass(name),true,name);
  for(const name of [null,'','byte[][]','../Secret','C:\\Secret','a.Foo/0x123','a.Foo<script>','a..Foo','[La.Foo;'])
    assert.equal(context.isProjectSourceClass(name),false,name);
});
test('Source uses its own correlated command, permits reopen and does not send file content',()=>{
  const h=harness(); h.context.renderSourceTab(entries); h.rows()[0].button.click();
  const first=h.sent[0];
  assert.deepEqual(Object.keys(first).sort(),['className','command','requestId']);
  assert.equal(first.command,'openProjectSource'); assert.ok(h.rows().every(row=>row.button.disabled));
  h.send('sourceNavigationResult',{...first,status:'indexing'});
  assert.match(h.elements.get('source-status').textContent,/indexing/);
  h.send('sourceNavigationResult',{...first,requestId:'wrong',status:'opened'});
  assert.match(h.elements.get('source-status').textContent,/indexing/);
  h.send('sourceNavigationResult',{...first,status:'opened'});
  assert.equal(h.rows()[0].button.textContent,'Open Again'); h.rows()[0].button.click();
  assert.notEqual(h.sent[1].requestId,first.requestId);
});
test('Source lifecycle retires requests and malformed statuses cannot enter the page',()=>{
  for(const [command,event] of [['serverCrashed',{}],['analysisCancelled',{}],['analysisProgress',{stage:'loading'}]]) {
    const h=harness(); h.context.renderSourceTab(entries); h.rows()[0].button.click(); const old=h.sent[0];
    h.send(command,event); assert.equal(h.context.sourceReady,false); assert.equal(h.context._tabRendered.source,true);
    assert.equal(h.elements.get('source-search').disabled,true);
    h.send('sourceNavigationResult',{...old,status:'opened'}); assert.equal(h.context.sourceReady,false);
    h.context.renderSourceTab(entries); h.rows()[0].button.click(); const fresh=h.sent[1];
    h.send('sourceNavigationResult',{...old,status:'opened'}); assert.match(h.elements.get('source-status').textContent,/Looking/);
    h.send('sourceNavigationResult',{...fresh,status:'<script>bad</script>'});
    assert.equal(h.elements.get('source-status').textContent,'Source lookup failed; try again');
    assert.ok(h.rows().every(row=>!row.button.disabled));
  }
});
test('Source bounds rendering without losing filter access or sharing state across editors',()=>{
  const h=harness(), other=harness();
  const many=Array.from({length:205},(_,i)=>({class_name:'example.C'+i,retained_size:i,instance_count:1}));
  h.context.renderSourceTab(many); assert.equal(h.rows().length,200); assert.equal(h.rows()[0].dataset.sourceClass,'example.C204');
  h.context._srcFilter='example.C0'; h.context.renderSourceTable();
  assert.equal(h.rows().length,1); assert.equal(h.rows()[0].dataset.sourceClass,'example.C0');
  other.context.renderSourceTab(entries); assert.equal(other.rows().length,2);
  h.rows()[0].button.click(); assert.ok(other.rows().every(row=>!row.button.disabled));
});
