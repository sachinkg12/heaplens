'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const internalContent=/\bparity\b|learning[\s_-]*log|enhancement[\s_-]*track|tracker_tasks|testing_enhancements|weekend[\s_-]*(?:checklist|testing|validation)|\b(?:TODO|TBD|FIXME|WIP)\b|\b(?:P[01]|CAP|QLT|PERF)-\d+\b|\/Users\/|[A-Za-z]:\\Users\\/i;
const rawLicenseLink=/\]\((?:\.{1,2}\/)*LICENSE(?:\.(?:md|txt))?(?:#[^)]*)?\)/i;
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
function blocks(raw){return [...raw.matchAll(/^```(\w*)\n([\s\S]*?)^```/gm)].map(m=>({language:m[1],text:m[2].trim()}));}
function check(site=path.resolve(__dirname,'..'),repo=path.resolve(site,'..')){
  const docs=walk(path.join(site,'docs')).filter(f=>/\.mdx?$/.test(f)),sidebar=fs.readFileSync(path.join(site,'sidebars.ts'),'utf8');
  let json=0,queries=0;
  for(const file of docs){const raw=fs.readFileSync(file,'utf8'),id=path.relative(path.join(site,'docs'),file).replace(/\\/g,'/').replace(/\.mdx?$/,'');
    assert.ok(sidebar.includes("'"+id+"'"),'Missing sidebar route: '+id);
    assert.match(raw,/^---\n[\s\S]*?^title:/m,'Missing title: '+id);
    assert.ok(!/\bMAT\b|\bEclipse\b/i.test(raw),'Documentation naming policy: '+id);
    assert.ok(!internalContent.test(raw),'Public documentation content policy: '+id);
    assert.ok(!rawLicenseLink.test(raw),'Repository license link must use its GitHub URL: '+id);
    for(const block of blocks(raw)){
      if(block.language==='json'){JSON.parse(block.text);json++;}
      if(['sql','heapql'].includes(block.language)){assert.ok(!/\bFROM\s+objects\b/i.test(block.text),'Invalid HeapQL table: '+id);queries++;}
    }
  }
  assert.ok(fs.existsSync(path.join(repo,'LICENSE')),'Repository license file is missing');
  const contributing=fs.readFileSync(path.join(site,'docs/architecture/contributing.md'),'utf8');
  assert.ok(contributing.includes('](https://github.com/sachinkg12/heaplens/blob/main/LICENSE)'),'Missing repository license link in contributor guide');
  const repositoryContributor=path.join(repo,'docs/CONTRIBUTING.md');
  const license=fs.readFileSync(repositoryContributor,'utf8').match(/\[Apache 2\.0 License\]\(([^)]+)\)/)?.[1];
  assert.ok(license&&(license==='https://github.com/sachinkg12/heaplens/blob/main/LICENSE'||path.resolve(path.dirname(repositoryContributor),license)===path.join(repo,'LICENSE')),'Contributor license link must resolve to the repository license');
  assert.ok(!internalContent.test(fs.readFileSync(path.join(repo,'hprof-analyzer/docs/CLI.md'),'utf8')),'Public documentation content policy: CLI entry guide');
  const native=fs.readFileSync(path.join(repo,'hprof-analyzer/src/main.rs'),'utf8');
  const definitions=native.slice(native.indexOf('fn mcp_tool_definitions()'),native.indexOf('fn get_analysis_state_for_path('));
  const names=[...definitions.matchAll(/"name":\s*"([a-z_]+)"/g)].map(m=>m[1]);
  assert.equal(names.length,9,'Update the documented MCP count');
  const mcp=fs.readFileSync(path.join(site,'docs/mcp/tools-reference.md'),'utf8');
  for(const name of names)assert.match(mcp,new RegExp('\\| '+name+' \\|'),'Undocumented MCP tool '+name);
  const registry=fs.readFileSync(path.join(repo,'src/llmClient.ts'),'utf8').split('PROVIDER_REGISTRY:')[1].split('\n};')[0];
  assert.equal((registry.match(/^    [a-z]+: \{/gm)||[]).length,10,'Update provider count');
  const template=fs.readFileSync(path.join(repo,'src/webview/template.ts'),'utf8');
  assert.equal(new Set([...template.matchAll(/id="tab-([a-z]+)"/g)].map(m=>m[1])).size,11,'Update tab count');
  const rpc=fs.readFileSync(path.join(site,'docs/api-reference/rpc-methods.md'),'utf8');
  assert.ok(rpc.includes('analysis_request_id'),'Wrong cancellation key');
  for(const block of blocks(rpc).filter(b=>b.language==='json')){const message=JSON.parse(block.text);if(message.method)assert.ok(native.includes('"'+message.method+'" =>'),'Unknown RPC method '+message.method);}
  const types=fs.readFileSync(path.join(site,'docs/api-reference/data-structures.md'),'utf8');
  for(const [name,source] of [['ObjectReport','lib.rs'],['RefSummary','lib.rs'],['FieldInfo','lib.rs'],['HeapSummary','lib.rs'],['ClassHistogramEntry','lib.rs'],['LeakSuspect','lib.rs'],['WasteAnalysis','waste.rs'],['QueryResult','heapql.rs']]){
    const rust=fs.readFileSync(path.join(repo,'hprof-analyzer/src',source),'utf8');
    const body=rust.match(new RegExp('pub struct '+name+' \\{([\\s\\S]*?)\\n\\}'))?.[1];
    const doc=types.match(new RegExp('interface '+name+' \\{([\\s\\S]*?)\\n\\}'))?.[1];
    assert.ok(body&&doc,'Missing type '+name);
    const serialized=body.replace(/#\[serde\(skip_serializing\)\]\s*pub \w+:[^\n]+/g,'');
    const actual=[...serialized.matchAll(/^\s*pub (\w+):/gm)].map(m=>m[1]).sort();
    const written=[...doc.matchAll(/^  (\w+)\??:/gm)].map(m=>m[1]).sort();
    assert.deepEqual(written,actual,'Schema drift in '+name);
  }
  console.log(JSON.stringify({docs:docs.length,json_examples:json,query_examples:queries,tabs:11,providers:10,mcp_tools:names.length,schemas:8}));
  return {docs,queries};
}
if(require.main===module){try{check(undefined,process.argv[2]?path.resolve(process.argv[2]):undefined);}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={walk,blocks,check};
