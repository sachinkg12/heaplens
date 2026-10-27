'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {check}=require('./check-contracts.cjs'),{check:links}=require('./check-links.cjs');
const site=path.resolve(__dirname,'..'),repo=path.resolve(process.env.DOCS_REPO||path.join(site,'..'));
function sandbox(fn){const temp=fs.mkdtempSync(path.join(os.tmpdir(),'heaplens-doc-checker-'));try{
  for(const file of ['sidebars.ts','docs'])fs.cpSync(path.join(site,file),path.join(temp,'site',file),{recursive:true});
  for(const file of ['LICENSE','docs/CONTRIBUTING.md','hprof-analyzer/docs/CLI.md','hprof-analyzer/src/main.rs','hprof-analyzer/src/mcp_scope.rs','hprof-analyzer/src/read_jobs.rs','hprof-analyzer/src/quick_scan.rs','hprof-analyzer/src/lib.rs','hprof-analyzer/src/waste.rs','hprof-analyzer/src/heapql.rs','src/llmClient.ts','src/webview/template.ts']){const target=path.join(temp,'repo',file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(repo,file),target);}
  fn(path.join(temp,'site'),path.join(temp,'repo'),temp);
}finally{fs.rmSync(temp,{recursive:true,force:true});}}
test('contract check accepts the complete corpus',()=>sandbox((s,r)=>check(s,r)));
for(const [label,content] of [
  ['host comparison notes','Internal parity testing instructions.'],
  ['learning records','See our LEARNING_LOG.md.'],
  ['enhancement records','See the enhancement tracker.'],
  ['internal issue IDs','Implementation is tracked as CAP-16 and P1-02.'],
  ['private source paths','Open /Users/example/private/dump.hprof.'],
  ['local testing directories','See testing_enhancements/fixtures.'],
  ['schedule-specific checklist links','See the weekend-checklist for CLI testing.'],
  ['unfinished authoring notes','TODO: replace this draft before publication.'],
]) test('internal engineering content is rejected: '+label,()=>sandbox((s,r)=>{
  fs.appendFileSync(path.join(s,'docs/getting-started/browser.md'),'\n'+content+'\n');
  assert.throws(()=>check(s,r),/Public documentation content policy/);
}));
test('raw repository license links are rejected on the website',()=>sandbox((s,r)=>{
  fs.appendFileSync(path.join(s,'docs/architecture/contributing.md'),'\n[Apache 2.0 License](LICENSE)\n');
  assert.throws(()=>check(s,r),/Repository license link/);
}));
test('moved contributor guide must link to the repository license',()=>sandbox((s,r)=>{
  const file=path.join(r,'docs/CONTRIBUTING.md');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('](../LICENSE)','](LICENSE)'));
  assert.throws(()=>check(s,r),/Contributor license link/);
}));
test('CLI entry guide cannot link to an internal scheduled checklist',()=>sandbox((s,r)=>{
  fs.appendFileSync(path.join(r,'hprof-analyzer/docs/CLI.md'),'\n[weekend checklist](CLI_WEEKEND_TESTING.md)\n');
  assert.throws(()=>check(s,r),/Public documentation content policy/);
}));
test('invalid JSON example fails the check',()=>sandbox((s,r)=>{fs.appendFileSync(path.join(s,'docs/api-reference/rpc-methods.md'),'\n```json\n{bad}\n```\n');assert.throws(()=>check(s,r));}));
test('invalid table fails the check',()=>sandbox((s,r)=>{fs.appendFileSync(path.join(s,'docs/api-reference/heapql.md'),'\n```heapql\nSELECT * FROM objects\n```\n');assert.throws(()=>check(s,r),/Invalid HeapQL/);}));
test('type drift fails the check',()=>sandbox((s,r)=>{const file=path.join(s,'docs/api-reference/data-structures.md');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('ref_summary?: RefSummary','ref_summary_wrong?: RefSummary'));assert.throws(()=>check(s,r),/Schema drift/);}));
test('shallow schema drift fails the check',()=>sandbox((s,r)=>{const file=path.join(s,'docs/api-reference/data-structures.md');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('declared_classes: number','total_classes_wrong: number'));assert.throws(()=>check(s,r),/Schema drift in ShallowSummary/);}));
test('unknown RPC example fails the check',()=>sandbox((s,r)=>{fs.appendFileSync(path.join(s,'docs/api-reference/rpc-methods.md'),'\n```json\n{"jsonrpc":"2.0","id":10,"method":"invented_method"}\n```\n');assert.throws(()=>check(s,r),/Unknown RPC method invented_method/);}));
test('read-worker dispatch is validated without depending on arrow spacing',()=>sandbox((s,r)=>{
  check(s,r);
  const file=path.join(r,'hprof-analyzer/src/read_jobs.rs');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('"get_children"=>','"get_children" =>'));
  check(s,r);
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('"get_children" =>','"undocumented_children" =>'));
  assert.throws(()=>check(s,r),/Unknown RPC method get_children/);
}));
test('tool definition drift fails the check',()=>sandbox((s,r)=>{const file=path.join(r,'hprof-analyzer/src/mcp_scope.rs');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('"get_summary",','"changed_tool",'));assert.throws(()=>check(s,r),/Undocumented MCP tool|MCP count/);}));
test('link check rejects missing pages and fragments',()=>sandbox((s,r,temp)=>{const root=path.join(temp,'build');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'index.html'),'<a href="/heaplens/missing/">bad</a><a href="#absent">fragment</a>');assert.throws(()=>links(root),/Broken local links/);}));
