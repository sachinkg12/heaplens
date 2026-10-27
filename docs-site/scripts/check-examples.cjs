'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),readline=require('node:readline');
const {spawn}=require('node:child_process');
const {walk,blocks}=require('./check-contracts.cjs');
function fixture(count){const header=Buffer.alloc(12);header.writeUInt32BE(8);const heap=Buffer.alloc(27+count);heap[0]=255;heap.writeBigUInt64BE(512n,1);heap[9]=0x23;heap.writeBigUInt64BE(512n,10);heap.writeUInt32BE(count,22);heap[26]=8;const record=Buffer.alloc(9);record[0]=0x1c;record.writeUInt32BE(heap.length,5);const end=Buffer.alloc(9);end[0]=0x2c;return Buffer.concat([Buffer.from('JAVA PROFILE 1.0.2\0'),header,record,heap,end]);}
function client(server,args=[]){const child=spawn(server,args,{stdio:['pipe','pipe','pipe'],env:{...process.env,DO_NOT_TRACK:'1',CI:'1'}}),pending=new Map(),notifications=[];let next=0;
  const lines=readline.createInterface({input:child.stdout});lines.on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined){pending.get(m.id)?.(m);pending.delete(m.id);}else notifications.push(m);});
  // Diagnostics are bounded and not printed; fixtures are synthetic.
  child.stderr.resume();
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Timed out: '+method));},15000);pending.set(id,m=>{clearTimeout(timer);resolve(m);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})+'\n');});
  child.on('error',error=>{for(const resolve of pending.values())resolve({error:{message:error.message}});});
  return {request,notifications,notify(method){child.stdin.write(JSON.stringify({jsonrpc:'2.0',method})+'\n');},close(){lines.close();child.kill('SIGTERM');}};
}
async function wait(predicate){const end=Date.now()+15000;while(!predicate()){if(Date.now()>end)throw new Error('Analysis notification timeout');await new Promise(r=>setTimeout(r,10));}}
async function check(server){const temp=fs.mkdtempSync(path.join(os.tmpdir(),'heaplens-doc-examples-')),a=path.join(temp,'synthetic with spaces.hprof'),b=path.join(temp,'second.hprof');fs.writeFileSync(a,fixture(9));fs.writeFileSync(b,fixture(19));const rpc=client(server),mcp=client(server,['--mcp','--mcp-allow-file',a,'--mcp-allow-file',b,'--mcp-share-metadata']);
  try{
    assert.equal((await rpc.request('ping')).result.status,'ok');
    for(const dump of [a,b]){const before=rpc.notifications.length,response=await rpc.request('analyze_heap',{path:dump});assert.ok(response.result,'Analysis acknowledgement');await wait(()=>rpc.notifications.slice(before).some(n=>n.method==='heap_analysis_complete'));const complete=rpc.notifications.slice(before).find(n=>n.method==='heap_analysis_complete');assert.equal(complete.params.status,'completed');assert.equal(complete.params.summary.total_arrays,1);for(const name of ['total_heap_size','reachable_heap_size','total_instances','total_classes','total_gc_roots','hprof_version','heap_types'])assert.ok(name in complete.params.summary,'Summary field '+name);}
    let queries=0,rpcExamples=0;
    const docs=walk(path.resolve(__dirname,'../docs')).filter(f=>/\.mdx?$/.test(f));
    for(const file of docs){for(const block of blocks(fs.readFileSync(file,'utf8'))){
      if(['sql','heapql'].includes(block.language)){const response=await rpc.request('execute_query',{path:a,query:block.text.replace(/123456/g,'512')});assert.ok(!response.error,file+': '+response.error?.message);assert.ok(Array.isArray(response.result.columns)&&Array.isArray(response.result.rows),'Query result schema');queries++;}
      if(block.language==='json'&&file.endsWith('rpc-methods.md')){const message=JSON.parse(block.text);if(message.method&&message.method!=='analyze_heap'){const params=JSON.parse(JSON.stringify(message.params||{}).replace(/\/absolute\/path\/app\.hprof|\/absolute\/path\/current\.hprof/g,a).replace(/\/absolute\/path\/baseline\.hprof/g,b));if(params.object_id)params.object_id=512;const before=rpc.notifications.length,response=await rpc.request(message.method,params);assert.ok(!response.error,'RPC example '+message.method);
        if(message.method==='scan_heap'){
          const id=response.result.request_id;
          await wait(()=>rpc.notifications.slice(before).some(n=>n.method==='heap_scan_complete'&&n.params.request_id===id));
          const scan=rpc.notifications.slice(before).find(n=>n.method==='heap_scan_complete'&&n.params.request_id===id).params;
          assert.equal(scan.status,'completed');assert.equal(scan.analysis_scope,'shallow');assert.equal(scan.summary.reachable_heap_size,null);
          assert.equal(scan.readiness.retained,'not_calculated');assert.ok(scan.class_histogram.every(row=>!('retained_size' in row)));
          assert.equal((await rpc.request('get_children',{path:a,object_id:512})).error.code,-32002,'Quick Scan must not expose the old full state');
          // Restore full analysis for subsequent graph-dependent examples.
          const start=rpc.notifications.length,full=await rpc.request('analyze_heap',{path:a});assert.ok(full.result,'Full-analysis acknowledgement after scan');
          await wait(()=>rpc.notifications.slice(start).some(n=>n.method==='heap_analysis_complete'&&n.params.request_id===full.result.request_id));
          assert.equal(rpc.notifications.slice(start).find(n=>n.method==='heap_analysis_complete'&&n.params.request_id===full.result.request_id).params.status,'completed');
        }
        if(message.method==='get_waste_analysis')assert.equal(typeof response.result.total_wasted_bytes,'number');
        rpcExamples++;}}
    }}
    assert.equal((await rpc.request('execute_query',{path:a,query:'SELECT * FROM objects'})).error.code,-32000,'Invalid query must fail');
    assert.ok(Array.isArray((await rpc.request('get_children',{path:a,object_id:512})).result));
    assert.equal((await rpc.request('inspect_object',{path:a,object_id:512})).result,null,'Array inspection has no instance fields');
    const comparison=(await rpc.request('compare_heaps',{baseline_path:a,current_path:b})).result;
    for(const name of ['baseline_path','current_path','summary_delta','histogram_delta','leak_suspect_changes','waste_delta'])assert.ok(name in comparison,'Compare field '+name);
    const exported=path.join(temp,'native-export.json');assert.equal((await rpc.request('export_json',{path:a,output_path:exported})).result.success,true);const data=JSON.parse(fs.readFileSync(exported,'utf8'));for(const name of ['source_file','summary','class_histogram','leak_suspects','object_leak_suspects','top_objects'])assert.ok(name in data,'Export field '+name);
    assert.equal((await mcp.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'docs-check',version:'1'}})).result.protocolVersion,'2024-11-05');
    mcp.notify('notifications/initialized');
    const tools=(await mcp.request('tools/list')).result.tools;assert.equal(tools.length,6);
    const tool=async(name,args)=>{const response=(await mcp.request('tools/call',{name,arguments:args})).result;assert.equal(response.isError,false,'MCP '+name);return JSON.parse(response.content[0].text);};
    assert.equal((await tool('list_dumps',{})).dumps.length,2);
    for(const dump_id of ['dump_1','dump_2']){const full=await tool('analyze_heap',{dump_id}),current={dump_id,analysis_id:full.analysis_id};await tool('get_summary',current);const read=await tool('investigate_heap',{...current,action:{operation:'object',object_id:'512'}});await tool('get_evidence',{...current,evidence_id:read.evidence.id});await tool('close_dump',current);}
    console.log(JSON.stringify({query_examples:queries,rpc_examples:rpcExamples,mcp_tools:tools.length,schemas:'checked',private_data:'none',telemetry:'disabled',external_ai_calls:0}));
  }finally{rpc.close();mcp.close();fs.rmSync(temp,{recursive:true,force:true});}
}
const index=process.argv.indexOf('--server'),server=index>=0?path.resolve(process.argv[index+1]):path.resolve(__dirname,'../../hprof-analyzer/target/release/hprof-server');
if(require.main===module)check(server).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={fixture,check};
