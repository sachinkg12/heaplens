import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {EvidenceLedger,exactObjectId,investigate,investigationSeed,INVESTIGATION_LIMITS,parseRead,parseInvestigationResponse,projectEngineEvidence,validateAnswer,renderAnswer,InvestigationMessage,ReadAction} from '../aiInvestigation';
import {readInvestigation} from '../investigationEngine';
import {AiReply} from '../aiToolProtocol';
import {CHAT_SCOPE_POLICY} from '../diagnosisPolicy';
import {HEAP_ANALYSIS_SYSTEM_PROMPT} from '../promptTemplates';

// Migrate historical action fixtures to native call parts. Production never parses chat as actions.
function nativeFixture(text:string,ledger:EvidenceLedger):string|AiReply{
    let v:any;try{v=parseInvestigationResponse(text);}catch{return text;}
    if(v?.action==='read')return {text:'',toolCalls:[{id:'call_'+Math.random().toString(36).slice(2),name:'heap_read',arguments:JSON.stringify({operation:v.tool,object_id:v.object_id})}]};
    if(v?.action==='answer')return renderAnswer(validateAnswer(v,ledger));
    return text;
}

const metadata={schema_version:1,operation:'object',selected:{object_id:'9007199254740993',class_name:'example.Owner',node_type:'Instance',shallow_size:'24',retained_size:'18446744073709551615'},rows:[],status:'complete',truncated:false};
const seed=investigationSeed({total_heap_size:2048,reachable_heap_size:1024,total_instances:2},[]);
function answer(id:string){return {action:'answer',facts:[{evidence_id:id,field:'selected.retained_size'}],hypotheses:[{text:'Ownership intent is not established by this snapshot.',evidence_ids:[id]}],next_checks:['Check the intended cache lifetime.']};}
function harness(adapter='one') {
    const controller=new AbortController(),ledger=new EvidenceLedger('snapshot-A',['9007199254740993']);
    let current=true,approved=true,modelCalls=0,reads=0;
    const messages:InvestigationMessage[][]=[];
    let model=async(input:InvestigationMessage[])=>{
        if(modelCalls===1)return JSON.stringify({action:'read',tool:'object',object_id:'9007199254740993'});
        const record=JSON.parse(input.at(-1)?.content.split('metadata): ')[1]||'{}');
        return JSON.stringify(answer(record.id));
    };
    let read:(action:ReadAction,signal:AbortSignal)=>Promise<unknown>=async()=>metadata;
    return {ledger,controller,messages,adapter,
        calls:()=>modelCalls,reads:()=>reads,setApproved:(v:boolean)=>{approved=v;},retire:()=>{current=false;},
        setModel:(fn:typeof model)=>{model=fn;},setRead:(fn:typeof read)=>{read=fn;},
        run:(initialRead?:ReadAction)=>investigate({scope:'snapshot-A',destination:adapter,signal:controller.signal,current:()=>current,initialRead,
            approve:async()=>approved,model:async(m)=>{modelCalls++;messages.push(m.map(x=>({...x})));return nativeFixture(await model(m),ledger);},
            read:async(a,s)=>{reads++;return read(a,s);}},ledger,'Investigate the owner',seed)};
}

test('two model adapters use identical read/evidence contracts and host-render exact values',async()=>{
    for(const adapter of ['synthetic-A','synthetic-B']){
        const h=harness(adapter),result=await h.run();
        assert.equal(result.modelCalls,2);assert.equal(result.reads,1);
        assert.match(result.text,/18446744073709551615/);
        assert.equal(result.evidence.length,1);assert.equal(result.evidence[0].operation,'object');
        assert.equal(h.ledger.field(result.evidence[0].id,'selected.retained_size'),'18446744073709551615');
        assert.equal(result.evidence[0].data.selected && (result.evidence[0].data.selected as any).object_id,'9007199254740993');
        assert.match(result.text,/not verified causes or repairs/);
    }
});
test('declined consent and a retired scope make zero model and engine calls',async()=>{
    for(const retired of [false,true]){
        const h=harness();if(retired)h.retire();else h.setApproved(false);
        await assert.rejects(h.run());assert.equal(h.calls(),0);assert.equal(h.reads(),0);
    }
});
test('fabricated values, unknown citations, scope mismatch and unavailable fields fail closed',()=>{
    const ledger=new EvidenceLedger('A'),record=ledger.add('object',projectEngineEvidence(metadata,{operation:'object',object_id:'9007199254740993'}));
    assert.throws(()=>validateAnswer({...answer(record.id),facts:[{evidence_id:record.id,field:'selected.retained_size',value:'1'}]},ledger));
    assert.throws(()=>validateAnswer(answer('invented'),ledger));
    assert.throws(()=>validateAnswer({...answer(record.id),facts:[{evidence_id:record.id,field:'selected.password'}]},ledger));
    assert.throws(()=>validateAnswer({...answer(record.id),facts:[{evidence_id:record.id,field:'summary.reachable_heap_size'}]},ledger));
    assert.throws(()=>projectEngineEvidence(metadata,{operation:'object',object_id:'5'}));
    assert.throws(()=>parseRead({action:'read',tool:'object',object_id:'9007199254740993'},new EvidenceLedger('B')));
});
test('unsafe numeric IDs are rejected; raw fields, source, paths and future data never enter the projection',()=>{
    assert.throws(()=>exactObjectId(Number.MAX_SAFE_INTEGER+2));
    assert.equal(exactObjectId('9007199254740993'),'9007199254740993');
    const projected=projectEngineEvidence({...metadata,source:'PRIVATE_SOURCE',path:'/PRIVATE_PATH',selected:{...metadata.selected,primitive_value:'PRIVATE_VALUE'}},
        {operation:'object',object_id:'9007199254740993'});
    assert.doesNotMatch(JSON.stringify(projected),/PRIVATE/);
    const snapshot=investigationSeed({total_instances:2,source:'PRIVATE'},[{object_id:42,class_name:'Owner',node_type:'Instance',shallow_size:24,retained_size:24,primitive_value:'PRIVATE'}]);
    assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE/);
});
test('model cannot choose an arbitrary query, path, shell, cost limit or invented object',()=>{
    const ledger=new EvidenceLedger('A',['42']);
    for(const input of [{action:'read',tool:'execute_query',object_id:'42'},{action:'read',tool:'object',object_id:'42',path:'/private'},
        {action:'read',tool:'object',object_id:'42',limit:999999},{action:'read',tool:'object',object_id:'43'}])assert.throws(()=>parseRead(input,ledger));
});
test('repeated reads fail closed; an exhausted budget returns labelled existing metadata without retries',async()=>{
    const duplicate=harness();duplicate.setModel(async()=>JSON.stringify({action:'read',tool:'object',object_id:'9007199254740993'}));
    await assert.rejects(duplicate.run(),/Repeated/);assert.equal(duplicate.calls(),2);assert.equal(duplicate.reads(),1);
    const h=harness();const operations=['object','outbound','referrers','root_path'];
    h.setModel(async()=>JSON.stringify({action:'read',tool:operations[h.calls()-1],object_id:'9007199254740993'}));
    h.setRead(async action=>({...metadata,operation:action.operation}));
    const result=await h.run();assert.equal(h.calls(),INVESTIGATION_LIMITS.modelCalls);assert.equal(h.reads(),INVESTIGATION_LIMITS.reads);
    assert.equal(result.metadataOnly,true);assert.match(result.text,/Metadata summary only/);assert.match(result.text,/not a completed AI diagnosis/);
    assert.equal(result.answer.hypotheses.length,0);assert.equal(result.answer.facts.find(f=>f.field==='summary.total_heap_size')?.value,'2048');
    assert.ok(h.messages[3].some(m=>m.role==='system' && m.content.includes('FINAL ANSWER ONLY')));
});
test('an overview can answer from existing evidence in one call with zero engine reads',async()=>{
    const h=harness();h.setModel(async messages=>{
        assert.ok(messages.some(m=>m.content.includes('Prefer answering from the supplied summary')));
        const current=messages.find(m=>m.content.startsWith('Current bounded metadata'));assert.ok(current);
        const record=JSON.parse(current.content.split('data): ')[1]);
        return JSON.stringify({action:'answer',facts:[{evidence_id:record.id,field:'summary.total_heap_size'}],hypotheses:[],next_checks:[]});
    });
    const result=await h.run();assert.equal(h.calls(),1);assert.equal(h.reads(),0);assert.equal(result.metadataOnly,undefined);
});
test('the final model step answers with existing evidence instead of asking for a fourth read',async()=>{
    const h=harness();const operations=['object','outbound','referrers'];h.setRead(async action=>({...metadata,operation:action.operation}));
    h.setModel(async messages=>{
        if(h.calls()<=3)return JSON.stringify({action:'read',tool:operations[h.calls()-1],object_id:'9007199254740993'});
        assert.ok(messages.some(m=>m.role==='system' && m.content.includes('FINAL ANSWER ONLY')));
        const current=messages.at(-1);assert.ok(current);
        const record=JSON.parse(current.content.split('metadata): ')[1]);return JSON.stringify(answer(record.id));
    });
    const result=await h.run();assert.equal(result.modelCalls,4);assert.equal(result.reads,3);assert.equal(result.metadataOnly,undefined);
});
test('a selected-object fallback uses its actual evidence and does not invent unavailable totals',async()=>{
    const h=harness();const operations=['outbound','referrers','root_path'];h.setRead(async action=>({...metadata,operation:action.operation}));
    h.setModel(async()=>JSON.stringify({action:'read',tool:operations[h.calls()-1],object_id:'9007199254740993'}));
    const result=await h.run({operation:'object',object_id:'9007199254740993'});
    assert.equal(result.metadataOnly,true);assert.equal(h.calls(),3);assert.equal(h.reads(),3);
    assert.equal(result.answer.facts.find(f=>f.field==='selected.retained_size')?.value,'18446744073709551615');
    assert.ok(!result.answer.facts.some(f=>f.field==='summary.total_classes'));
});
test('an exhausted budget cannot turn an invented or forbidden read into an accepted summary',async()=>{
    for(const last of [{action:'read',tool:'object',object_id:'999'}, {action:'read',tool:'execute_query',object_id:'9007199254740993'}]){
        const h=harness();const operations=['object','outbound','referrers'];h.setRead(async action=>({...metadata,operation:action.operation}));
        h.setModel(async()=>JSON.stringify(h.calls()<=3?{action:'read',tool:operations[h.calls()-1],object_id:'9007199254740993'}:last));
        await assert.rejects(h.run());assert.equal(h.calls(),4);assert.equal(h.reads(),3);
    }
});
test('unknown evidence handles fail closed even in ordinary prose',async()=>{
    const h=harness();h.setModel(async()=>'Here is an answer with a fake citation [E000000000000_1].');
    await assert.rejects(h.run(),/Evidence/);assert.equal(h.calls(),1);assert.equal(h.reads(),0);
});
test('cancelling the final model step cannot turn a refused read into a metadata summary',async()=>{
    const h=harness();const operations=['object','outbound','referrers','root_path'];h.setRead(async action=>({...metadata,operation:action.operation}));
    h.setModel(async()=>{if(h.calls()===4)h.controller.abort();return JSON.stringify({action:'read',tool:operations[h.calls()-1],object_id:'9007199254740993'});});
    await assert.rejects(h.run(),/cancelled/);assert.equal(h.calls(),4);assert.equal(h.reads(),3);
});
test('the actual request including budget guidance is checked before sending oversized history',async()=>{
    const ledger=new EvidenceLedger('bounded-context'),controller=new AbortController();let calls=0;
    await assert.rejects(investigate({scope:ledger.scope,destination:'synthetic',signal:controller.signal,current:()=>true,
        approve:async()=>true,model:async()=>{calls++;return '{}';},read:async()=>{throw Error('unexpected read');}},ledger,
    'Overview',seed,[{role:'user',content:'x'.repeat(INVESTIGATION_LIMITS.contextBytes)}]),/context limit/);
    assert.equal(calls,0);
});
test('Stop during model or engine wait aborts the same investigation and never publishes a final answer',async()=>{
    for(const stage of ['model','read']){
        const h=harness();let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});
        if(stage==='model')h.setModel(async()=>{entered();return new Promise<string>(()=>undefined);});
        else h.setRead(async(_action,signal)=>{assert.equal(signal.aborted,false);entered();return new Promise<unknown>(()=>undefined);});
        const running=h.run();await started;h.controller.abort();await assert.rejects(running,/cancelled/);
        assert.ok(h.calls()<=1);
    }
});
test('engine port sends exact IDs and originating analysis; cancellation addresses only its job',async()=>{
    const calls:Array<{method:string;params:any}>=[];let reply!:(value:unknown)=>void;
    const engine={sendRequest:async(method:string,params:unknown)=>{calls.push({method,params});if(method==='cancel_investigation')return {};return new Promise(r=>{reply=r;});}};
    const c=new AbortController();const running=readInvestigation(engine,'/LOCAL_ONLY','17',{operation:'object',object_id:'9007199254740993'},c.signal);
    assert.equal(calls[0].params.action.object_id,'9007199254740993');assert.equal(calls[0].params.analysis_id,'17');
    c.abort();assert.equal(calls[1].method,'cancel_investigation');assert.equal(calls[1].params.job_id,calls[0].params.job_id);
    reply({analysis_id:'17',evidence:metadata});await assert.rejects(running,/cancelled/);
});
test('unknown engine fields are not approved data, and incomplete paths retain an explicit incomplete status',()=>{
    const data=projectEngineEvidence({...metadata,operation:'root_path',status:'budget_exhausted',truncated:true,rows:[],secret:'PRIVATE'},
        {operation:'root_path',object_id:'9007199254740993'});
    assert.equal(data.status,'budget_exhausted');assert.equal(data.truncated,true);assert.doesNotMatch(JSON.stringify(data),/PRIVATE/);
    const ledger=new EvidenceLedger('A'),record=ledger.add('root_path',data);
    const result=validateAnswer({action:'answer',facts:[{evidence_id:record.id,field:'status'}],hypotheses:[],next_checks:['The bounded search was incomplete.']},ledger);
    assert.match(renderAnswer(result),/budget_exhausted/);assert.throws(()=>ledger.field(record.id,'unreachable'));
});
test('ledger exports copies, caps retained evidence and rejects stale handles in a new scope',()=>{
    const ledger=new EvidenceLedger('A'),r=ledger.add('summary',seed);(r.data.summary as any).total_instances='999';
    assert.equal(ledger.field(r.id,'summary.total_instances'),'2');
    assert.throws(()=>new EvidenceLedger('B').get(r.id));
    for(let i=1;i<INVESTIGATION_LIMITS.records;i++)ledger.add('summary',seed);
    assert.throws(()=>ledger.add('summary',seed),/limit/);
});
test('follow-up citations export the actual earlier evidence instead of an expired-looking link',async()=>{
    const h=harness();const first=await h.run(),previous=first.evidence.find(e=>e.operation==='object');assert.ok(previous);
    h.setModel(async()=>JSON.stringify(answer(previous.id)));
    const second=await h.run();
    assert.equal(second.reads,0);assert.ok(second.evidence.some(e=>e.id===previous.id));
    assert.equal(h.ledger.field(previous.id,'selected.retained_size'),'18446744073709551615');
});
test('consent waiting is cancellable; oversized ledgers and names are not silently treated as complete',async()=>{
    const c=new AbortController(),ledger=new EvidenceLedger('A');let entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});let calls=0;
    const running=investigate({scope:'A',destination:'synthetic',signal:c.signal,current:()=>true,
        approve:async()=>{entered();return new Promise<boolean>(()=>undefined);},
        model:async()=>{calls++;return '';},read:async()=>{calls++;return {};}},ledger,'Question',seed);
    await started;c.abort();await assert.rejects(running,/cancelled/);assert.equal(calls,0);
    assert.throws(()=>ledger.add('summary',{text:'x'.repeat(65537)}),/budget/);
    const clipped=investigationSeed({},[],[{class_name:'x'.repeat(300),instance_count:1,shallow_size:1,retained_size:1}]);
    assert.equal((clipped.classes as any[])[0].name_truncated,true);
    const record=ledger.add('summary',clipped);
    const answer=validateAnswer({action:'answer',facts:[{evidence_id:record.id,field:'classes.0.class_name'}],hypotheses:[],next_checks:[]},ledger);
    assert.match(renderAnswer(answer),/name truncated/);
});

test('one JSON fence or BOM is presentation only and consumes no retry or extra read',async()=>{
    const wrappers=[(text:string)=>'\ufeff '+text+'\n', (text:string)=>'```json\n'+text+'\n```',
        (text:string)=>'```\n'+text+'\n```', (text:string)=>' ```JSON\r\n'+text+'\r\n``` '];
    for(const wrap of wrappers){
        const h=harness();
        h.setModel(async input=>h.calls()===1
            ? wrap(JSON.stringify({action:'read',tool:'object',object_id:'9007199254740993'}))
            : wrap(JSON.stringify(answer(JSON.parse(input.at(-1)?.content.split('metadata): ')[1]||'{}').id))));
        const result=await h.run();
        assert.equal(result.modelCalls,2);assert.equal(result.reads,1);
        assert.match(result.text,/18446744073709551615/);
    }
});

test('legacy machine parser never extracts or repairs prose; normal Chat does not depend on it',()=>{
    const value=JSON.stringify({action:'answer',facts:[],hypotheses:[],next_checks:['Insufficient evidence.']});
    for(const text of ['', 'Here is the answer: '+value, value+value, '```json\n'+value+'\n```\nextra',
        '```javascript\n'+value+'\n```', value.slice(0,-1)]){
        assert.throws(()=>parseInvestigationResponse(text),/invalid investigation/);
    }
    assert.throws(()=>parseInvestigationResponse(' '.repeat(32769)),/limit/);
});

test('real reported prompts accept natural conversation in one call, not mandatory JSON',async()=>{
    for(const question of ['hi','tell me about this heapdump','i want to investigate, what is taking memory, how can i fix it, what is the heapql?']){
        const ledger=new EvidenceLedger('normal'),signal=new AbortController().signal;let calls=0,reads=0;
        const result=await investigate({scope:'normal',destination:'synthetic',signal,current:()=>true,approve:async()=>true,
            model:async messages=>{calls++;assert.ok(messages.some(m=>m.content.includes('NOT OQL')));assert.equal(messages.at(-1)?.content,question);return 'I can help inspect retained memory and suggest HeapQL queries. A snapshot alone does not prove a leak.';},
            read:async()=>{reads++;throw Error('unexpected');}},ledger,question,seed);
        assert.match(result.text,/I can help/);assert.equal(calls,1);assert.equal(reads,0);
    }
});
test('JSON-shaped prose is never executable and native tool parts are the only read authority',async()=>{
    let reads=0;
    const ledger=new EvidenceLedger('text'),result=await investigate({scope:'text',destination:'synthetic',signal:new AbortController().signal,current:()=>true,approve:async()=>true,
        model:async()=>'{"action":"read","tool":"execute_query","object_id":"42"}',read:async()=>{reads++;throw Error('unexpected');}},ledger,'Explain this JSON example',seed);
    assert.match(result.text,/execute_query/);assert.equal(reads,0);
});

test('shared scope reaches ordinary Chat without reinstating mandatory JSON or a keyword gate',async()=>{
    assert.ok(HEAP_ANALYSIS_SYSTEM_PROMPT.includes(CHAT_SCOPE_POLICY));
    const questions=['hi','who is amitabh bachchan','write a birthday poem','what is garbage collection?',
        'Who retains this HashMap and what is HeapQL? Also tell me about a film actor.','Why?'];
    for(const question of questions){
        let calls=0,reads=0;
        const ledger=new EvidenceLedger('scope-policy');
        const result=await investigate({scope:ledger.scope,destination:'synthetic',signal:new AbortController().signal,current:()=>true,approve:async()=>true,
            model:async messages=>{calls++;const policy=messages.find(m=>m.role==='system')?.content||'';
                assert.ok(policy.includes(CHAT_SCOPE_POLICY));assert.match(policy,/briefly decline the rest/);
                assert.match(policy,/fenced code block tagged heapql/);assert.match(policy,/Do not return an action\/answer JSON/);
                assert.equal(messages.at(-1)?.content,question);
                // Synthetic reply: this checks the request contract, not a live model's compliance.
                return 'I can help with Java heap analysis and HeapQL.';},read:async()=>{reads++;throw Error('Unexpected read');}},ledger,question,seed);
        assert.equal(result.modelCalls,1);assert.equal(calls,1);assert.equal(reads,0);assert.deepEqual(result.evidence,[]);
    }
});
test('uncited available metadata is never attached to greetings, refusals or general explanations',async()=>{
    for(const text of ['Hi! What would you like to inspect in this heap?',
        'I can help with Java heap analysis, not unrelated biographies. What would you like to inspect?',
        'Retained size includes objects exclusively kept alive by an owner.']){
        const h=harness();h.setModel(async()=>text);const result=await h.run();
        assert.equal(result.text,text);assert.deepEqual(result.evidence,[]);assert.equal(result.reads,0);
    }
    const h=harness();h.setModel(async()=> 'Check the intended lifecycle before calling it a leak.');
    const result=await h.run({operation:'object',object_id:'9007199254740993'});
    assert.equal(result.reads,1);assert.deepEqual(result.evidence,[],'A completed read is not automatically a citation');
});
test('only cited records are attached, including earlier same-scope evidence, with no duplicates',async()=>{
    const h=harness(),first=await h.run(),prior=first.evidence[0];
    h.setModel(async messages=>{
        const current=JSON.parse(messages.find(m=>m.content.startsWith('Current bounded metadata'))!.content.split('data): ')[1]);
        return 'The selected owner retains memory ['+prior.id+']. The total comes from the summary ['+current.id+']. Again ['+prior.id+'].';
    });
    const second=await h.run();assert.equal(second.reads,0);
    assert.equal(second.evidence.length,2);assert.equal(second.evidence[0].id,prior.id);assert.equal(second.evidence[1].operation,'summary');
});

test('fence normalization does not admit invented facts, citations or tool authority',()=>{
    const ledger=new EvidenceLedger('A',['42']);
    const record=ledger.add('object',projectEngineEvidence(metadata,{operation:'object',object_id:'9007199254740993'}));
    const parse=(value:unknown)=>parseInvestigationResponse('```json\n'+JSON.stringify(value)+'\n```');
    assert.throws(()=>validateAnswer(parse({...answer(record.id),facts:[{evidence_id:record.id,field:'selected.retained_size',value:'1'}]}),ledger));
    assert.throws(()=>validateAnswer(parse(answer('invented')),ledger));
    assert.throws(()=>parseRead(parse({action:'read',tool:'execute_query',object_id:'42'}),ledger));
    assert.throws(()=>parseRead(parse({action:'read',tool:'object',object_id:42}),ledger));
    assert.throws(()=>parseRead(parse({action:'read',tool:'object',object_id:'43'}),ledger));
});
