import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { editorHarness,FakeServer,settle } from './editorHarness';
import type { CopilotAnalysisScope } from '../copilotScope';
import { CHAT_SCOPE_POLICY } from '../diagnosisPolicy';

function harness(chatAvailable=true){
    // Synchronous module interception only; no installed host, credentials or provider calls.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const modules=require('module') as any,original=modules._load;
    let handler:any;const commands=new Map<string,any>(),sent:any[]=[];let approved=true,valid=true;
    let reply:(messages:any[])=>Promise<string>=async()=>JSON.stringify({action:'answer',facts:[],hypotheses:[{text:'Possible cause; not verified.',evidence_ids:[]}],next_checks:[]});
    const controller=new AbortController(),listeners=new Set<()=>void>(),subscriptions:any[]=[];
    const data={summary:{total_heap_size:88},topObjects:[{object_id:'42',class_name:'Owner',node_type:'Instance',shallow_size:24,retained_size:88}],classHistogram:[],path:'SECRET_PATH',wasteAnalysis:{preview:'SECRET_VALUE'}};
    const scope=()=>({identity:'dump-A',label:'approved.hprof',data,signal:controller.signal,current:()=>valid,
        read:async(action:any)=>({schema_version:1,operation:action.operation,selected:{object_id:action.object_id,class_name:'ActualOwner',node_type:'Instance',shallow_size:'24',retained_size:'88'},rows:[],truncated:false,status:'complete'}),dispose:()=>undefined} as unknown as CopilotAnalysisScope);
    class ResponseTurn{constructor(public result:any){}}
    class Literal{value='';isTrusted=false;supportHtml=false;appendText(text:string){this.value+=text;return this;}}
    class Cancellation{token={isCancellationRequested:false,onCancellationRequested:(fn:()=>void)=>{listeners.add(fn);return {dispose:()=>listeners.delete(fn)};}};cancel(){this.token.isCancellationRequested=true;listeners.forEach(fn=>fn());}dispose(){return undefined;}}
    class TextPart{constructor(public value:string){}}
    class ToolPart{constructor(public callId:string,public name:string,public input:object){}}
    class ToolResult{constructor(public callId:string,public content:any[]){}}
    const model={vendor:'selected-vendor',id:'selected-id',name:'Selected model',version:'1',capabilities:{toolCalling:true},sendRequest:async(messages:any[],options:any,token:any)=>{sent.push({messages,token,options});return {stream:(async function*(){
        const text=await reply(messages);let v:any;try{v=JSON.parse(text);}catch{/* prose */}
        if(v?.action==='read')yield new ToolPart('call_'+sent.length,'heap_read',{operation:v.tool,object_id:v.object_id});else yield new TextPart(text);
    })()};}};
    const api={ChatResponseTurn:ResponseTurn,MarkdownString:Literal,ThemeIcon:class{},CancellationTokenSource:Cancellation,LanguageModelTextPart:TextPart,LanguageModelToolCallPart:ToolPart,LanguageModelToolResultPart:ToolResult,
        LanguageModelChatMessage:{User:(content:string)=>({role:'user',content}),Assistant:(content:string)=>({role:'assistant',content})},
        chat:chatAvailable?{createChatParticipant:(_name:string,callback:any)=>{handler=callback;return {dispose:()=>undefined};}}:undefined,
        commands:{registerCommand:(id:string,callback:any)=>{commands.set(id,callback);return {dispose:()=>undefined};}},
        window:{showInformationMessage:async()=>approved?'Approve this question':undefined,showWarningMessage:()=>undefined,showTextDocument:async()=>undefined},workspace:{openTextDocument:async()=>({})}};
    const file=require.resolve('../chatParticipant');delete require.cache[file];modules._load=function(id:string,parent:any,isMain:boolean){return id==='vscode'?api:original.call(this,id,parent,isMain);};
    try{original.call(modules,file,module,false).registerChatParticipant({subscriptions},scope);}finally{modules._load=original;}
    async function send(prompt:string,previous?:any,untrustedHistory?:any[]){const markdown:any[]=[],buttons:any[]=[];const token=new Cancellation();const result=await handler({prompt,model},
        {history:untrustedHistory??(previous?[new ResponseTurn(previous)]:[])},{markdown:(v:any)=>markdown.push(v),progress:()=>undefined,button:(v:any)=>buttons.push(v)},token.token);return {result,markdown,buttons,token};}
    return {send,sent,model,commands,controller,ResponseTurn,subscriptions,reply:(fn:typeof reply)=>{reply=fn;},approve:(value:boolean)=>{approved=value;},invalidate:()=>{valid=false;},close:()=>subscriptions.forEach(s=>s.dispose())};
}

test('Copilot uses only the selected model after consent and never sends raw ChatContext or values',async()=>{
    const h=harness();try{h.approve(false);await h.send('Decline');assert.equal(h.sent.length,0);h.approve(true);
        await h.send('Approved',undefined,[{prompt:'SECRET_OTHER_CHAT',response:'SECRET_HISTORY'}]);assert.equal(h.sent.length,1);const body=JSON.stringify(h.sent);assert.doesNotMatch(body,/SECRET_/);assert.match(body,/Owner/);
    }finally{h.close();}
});
test('missing optional chat API does not break ordinary extension registration',()=>{
    const h=harness(false);try{assert.equal(h.subscriptions.length,0);assert.equal(h.sent.length,0);}finally{h.close();}
});
test('arbitrary selected Copilot vendors accept conversation and reject invented evidence handles without fallback',async()=>{
    const h=harness();try{
        for(const vendor of ['vendor-one','vendor-two','local-model']){
            h.model.vendor=vendor;
            h.reply(async()=> 'Insufficient evidence to establish a cause; inspect the owner lifecycle.');
            const before=h.sent.length,answer=await h.send('Investigate');assert.ok(answer.result);assert.equal(h.sent.length,before+1);
            h.reply(async()=> 'A claim with invented evidence [E000000000000_1].');
            const rejected=await h.send('Forge');assert.equal(rejected.result,undefined);assert.equal(h.sent.length,before+2);
        }
    }finally{h.close();}
});
test('completion history tokens are immutable snapshots, including forks from older turns',async()=>{
    const h=harness();try{const a=await h.send('QUESTION_A');const b=await h.send('QUESTION_B',a.result);assert.match(JSON.stringify(h.sent[1]),/QUESTION_A/);
        await h.send('FORK_FROM_A',a.result);assert.doesNotMatch(JSON.stringify(h.sent[2]),/QUESTION_B/);assert.match(JSON.stringify(h.sent[2]),/QUESTION_A/);
        h.model.id='new-model';await h.send('NEW_MODEL',b.result);assert.doesNotMatch(JSON.stringify(h.sent[3]),/QUESTION_A|QUESTION_B/);
    }finally{h.close();}
});
test('model markup is rendered literally and evidence handles expire with the originating analysis',async()=>{
    const h=harness();try{h.reply(async messages=>{const record=JSON.parse(messages.find(m=>typeof m.content==='string'&&m.content.startsWith('Current bounded metadata')).content.split('data): ')[1]);
        return '[execute](command:evil) <img onerror=evil> ['+record.id+']';});
        const answer=await h.send('Explain');const rendered=answer.markdown.find(v=>typeof v!=='string');assert.equal(rendered.isTrusted,false);assert.equal(rendered.supportHtml,false);assert.match(rendered.value,/command:evil/);
        h.invalidate();await h.commands.get('heaplens.showCopilotEvidence')(...answer.buttons[0].arguments);
        await h.send('STALE',answer.result);assert.equal(h.sent.length,1);
    }finally{h.close();}
});
test('Copilot shares the scope policy and does not attach metadata or evidence warnings to uncited replies',async()=>{
    const h=harness();try{
        h.reply(async messages=>{assert.ok(messages.some(m=>typeof m.content==='string'&&m.content.includes(CHAT_SCOPE_POLICY)));
            return 'I can help with heap analysis and HeapQL, not unrelated biographies.';});
        const answer=await h.send('who is amitabh bachchan');assert.ok(answer.result);assert.equal(h.sent.length,1);assert.deepEqual(answer.buttons,[]);
        assert.ok(!answer.markdown.some(m=>typeof m==='string'&&m.includes('Evidence links')));
    }finally{h.close();}
});
test('originating-scope cancellation cancels the selected provider and claims no completed answer',async()=>{
    const h=harness();try{let release!:(s:string)=>void;h.reply(()=>new Promise(resolve=>{release=resolve;}));const pending=h.send('Pending');await settle();assert.equal(h.sent.length,1);
        h.controller.abort();assert.equal(h.sent[0].token.isCancellationRequested,true);release('{}');const result=await pending;assert.equal(result.result,undefined);assert.ok(result.markdown.every(v=>typeof v==='string'));
    }finally{h.close();}
});
test('Copilot cannot invent tools or unknown object IDs, and applies the same read budget',async()=>{
    const h=harness();try{h.reply(async()=>JSON.stringify({action:'read',tool:'object',object_id:'9999'}));const failed=await h.send('Invented object');assert.equal(failed.result,undefined);assert.equal(h.sent.length,1);
        h.reply(async()=>JSON.stringify({action:'read',tool:'object',object_id:'42'}));const repeated=await h.send('Repeat');assert.equal(repeated.result,undefined);assert.equal(h.sent.length,3);
    }finally{h.close();}
});
test('Copilot shows the bounded metadata fallback without forwarding it as completed model history',async()=>{
    const h=harness();try{
        const operations=['object','outbound','referrers','root_path'];
        h.reply(async messages=>{
            if(h.sent.length===4)assert.ok(messages.some(m=>m.content.includes('FINAL ANSWER ONLY')));
            return JSON.stringify({action:'read',tool:operations[h.sent.length-1],object_id:'42'});
        });
        const summary=await h.send('tell me about this heapdump');assert.equal(h.sent.length,4);assert.equal(summary.result.metadata.metadataOnly,true);
        assert.ok(summary.markdown.some(m=>typeof m!=='string'&&m.value.includes('Metadata summary only')));
        h.reply(async()=>JSON.stringify({action:'answer',facts:[],hypotheses:[],next_checks:['Check application lifecycle.']}));
        await h.send('Next question',summary.result);assert.doesNotMatch(JSON.stringify(h.sent[4]),/Metadata summary only|tell me about this heapdump/);
    }finally{h.close();}
});

test('disposed old Copilot scope cannot delete replacement cancellation tracking after Clear',async()=>{
    const h=editorHarness(()=>new FakeServer()),view=h.panel();try{await h.open('/tmp/copilot.hprof',view);await view.send({command:'ready'});
        const old=h.provider.captureCopilotScope();assert.ok(old);h.provider.clearChatHistory('/tmp/copilot.hprof');assert.equal(old.signal.aborted,true);
        const fresh=h.provider.captureCopilotScope();assert.ok(fresh);old.dispose();h.provider.clearChatHistory('/tmp/copilot.hprof');assert.equal(fresh.signal.aborted,true);assert.equal(fresh.current(),false);
    }finally{h.provider.dispose();}
});
test('captured Copilot scope survives neither server death nor Retry and never changes dump',async()=>{
    const h=editorHarness(()=>new FakeServer()),view=h.panel();try{await h.open('/tmp/copilot-origin.hprof',view);await view.send({command:'ready'});const origin=h.provider.captureCopilotScope();assert.ok(origin);
        const other=h.panel();await h.open('/tmp/copilot-other.hprof',other);await other.send({command:'ready'});assert.equal(origin.label,'copilot-origin.hprof');assert.equal(origin.current(),true);
        view.close();assert.equal(origin.signal.aborted,true);assert.equal(origin.current(),false);
        const remaining=h.provider.captureCopilotScope();assert.ok(remaining);(h.provider.getEditorClient('/tmp/copilot-other.hprof')as unknown as FakeServer).die();assert.equal(remaining.signal.aborted,true);assert.equal(remaining.current(),false);
    }finally{h.provider.dispose();}
});
