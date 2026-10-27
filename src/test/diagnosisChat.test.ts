import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { editorHarness, FakeServer, settle } from './editorHarness';
import type { ChatMessage, LlmConfig, LlmRequestOptions } from '../llmClient';
import { CHAT_SCOPE_POLICY } from '../diagnosisPolicy';

async function chatHarness() {
    class TestEngine extends FakeServer {
        override async sendRequest(method:string,params?:any,timeoutMs?:number):Promise<any>{
            if(method==='investigate_heap'){
                this.requests.push({method,params,timeoutMs});
                return {analysis_id:params.analysis_id,evidence:{schema_version:1,operation:params.action.operation,
                    selected:{object_id:params.action.object_id,class_name:'EngineOwner',node_type:'Instance',shallow_size:'24',retained_size:'88'},
                    rows:[],truncated:false,status:'complete'}};
            }
            return super.sendRequest(method,params,timeoutMs);
        }
    }
    const host = editorHarness(() => new TestEngine()), view = host.panel();
    host.setAiDecision(async()=>'Approve this AI session');
    const config: LlmConfig = { provider: 'openai', apiKey: 'TEST_ONLY_KEY', model: 'test-model' };
    const saved: unknown[] = [];
    const internals = host.provider as unknown as {
        llmConfiguration: { getConfig(): Promise<LlmConfig> };
        context: { workspaceState: { update(key: string, value: unknown): void } };
    };
    internals.llmConfiguration = { getConfig: async () => ({ ...config }) };
    internals.context.workspaceState.update = (_key, value) => { saved.push(value); };
    await host.open('/tmp/diagnosis-chat.hprof', view);
    await view.send({ command: 'ready' });
    // CommonJS injection is confined to this test process; no network or credentials are used.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const transport = require('../llmClient') as typeof import('../llmClient');
    const original = transport.callLlmChat;
    const calls: Array<{ messages: ChatMessage[]; chunk(text: string): void; done(): void; fail(text: string): void; options: LlmRequestOptions }> = [];
    transport.callLlmChat = (_config,messages,options={}) => new Promise((resolve,reject)=>{
        let answer='';
        calls.push({messages,chunk:text=>{answer+=text;},done:()=>{
            let v:any;try{v=JSON.parse(answer);}catch{/* natural text */}
            resolve(v?.action==='read'?{text:'',toolCalls:[{id:'call_'+calls.length,name:'heap_read',arguments:JSON.stringify({operation:v.tool,object_id:v.object_id})}]}:{text:answer,toolCalls:[]});
        },fail:text=>reject(Error(text)),options});
        options.signal?.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});
    });
    const start=async(action:()=>Promise<void>)=>{void action();await settle();await settle();};
    return { ...host, view, config, calls, saved,
        send: (text: string) => start(()=>host.provider.handleChatMessage(text, '/tmp/diagnosis-chat.hprof', view.value as never)),
        explain: (kind:'object'|'leak',message:any={objectId:'42',className:'EngineOwner'})=>start(()=>host.provider.handleExplain(message,kind,'/tmp/diagnosis-chat.hprof',view.value as never)),
        answer:async(index:number,text:string)=>{calls[index].chunk(text);calls[index].done();await settle();},
        close: () => { host.provider.dispose(); transport.callLlmChat = original; } };
}

test('explicit inline queries use a private correlated reply and do not make an AI request',async()=>{
    const h=await chatHarness();try{
        const query='SELECT object_id FROM instances LIMIT 5';
        await h.view.send({command:'executeQuery',query,requestId:'chat-query-1'});
        const response=h.view.messages.filter(m=>m.command==='chatQueryResult').at(-1);assert.ok(response);
        assert.equal(response.requestId,'chat-query-1');assert.equal(response.query,query);assert.equal(h.calls.length,0);
        assert.ok(!h.view.messages.some(m=>m.command==='queryResult' && m.query===query));
        await h.view.send({command:'executeQuery',query});assert.ok(h.view.messages.some(m=>m.command==='queryResult' && m.query===query));
    }finally{h.close();}
});

test('VS Code sends the shared scope policy; uncited refusals and greetings have no evidence attachments',async()=>{
    const h=await chatHarness();try{
        for(const [i,text] of ['who is amitabh bachchan','hi','what is HeapQL?'].entries()){
            await h.send(text);assert.ok(h.calls[i].messages.some(m=>m.role==='system'&&m.content.includes(CHAT_SCOPE_POLICY)));
            await h.answer(i,i===0?'I can help with heap analysis, not unrelated biographies.':'I can help with Java memory analysis and HeapQL.');
            const done=h.view.messages.filter(m=>m.command==='chatDone').at(-1);assert.ok(done);assert.deepEqual(done.evidence,[]);
        }
        const engine=h.provider.getEditorClient('/tmp/diagnosis-chat.hprof') as unknown as FakeServer;
        assert.equal(h.calls.length,3);assert.equal(engine.requests.filter(r=>r.method==='investigate_heap').length,0);
    }finally{h.close();}
});

test('inline query failures preserve correlation and never become model messages',async()=>{
    const h=await chatHarness();try{
        const engine=h.provider.getEditorClient('/tmp/diagnosis-chat.hprof') as unknown as FakeServer;
        const original=engine.sendRequest.bind(engine);engine.sendRequest=async(method,params,timeout)=>{if(method==='execute_query')throw Error('Synthetic query rejection');return original(method,params,timeout);};
        await h.view.send({command:'executeQuery',query:'SELECT missing FROM instances',requestId:'chat-query-2'});
        const response=h.view.messages.filter(m=>m.command==='chatQueryError').at(-1);assert.ok(response);assert.equal(response.requestId,'chat-query-2');assert.equal(h.calls.length,0);
    }finally{h.close();}
});

test('Retry discards an old inline query reply instead of displaying it in the replacement analysis',async()=>{
    const h=await chatHarness();try{
        const engine=h.provider.getEditorClient('/tmp/diagnosis-chat.hprof') as unknown as FakeServer;
        const original=engine.sendRequest.bind(engine);let finish!:(value:unknown)=>void;
        engine.sendRequest=async(method,params,timeout)=>method==='execute_query'?new Promise(resolve=>{finish=resolve;}):original(method,params,timeout);
        const pending=h.view.send({command:'executeQuery',query:'SELECT object_id FROM instances',requestId:'chat-query-1'});await settle();
        await h.view.send({command:'analyzeRetained'});finish({columns:['class_name'],rows:[['OLD_ANALYSIS_ONLY']]});await pending;
        assert.ok(!h.view.messages.some(m=>m.command==='chatQueryResult'||m.command==='chatQueryError'));assert.equal(h.calls.length,0);
    }finally{h.close();}
});

test('real chat orchestration includes current metadata on followups and persists completed turns only', async () => {
    const h = await chatHarness();
    try {
        await h.send('What retains memory?');
        assert.equal(h.saved.length, 0);
        await h.answer(0,'First answer');
        assert.equal(h.saved.length, 1);
        await h.send('Why is it retained?');
        assert.match(h.calls[1].messages[1].content, /Current bounded metadata/);
        assert.ok(h.calls[1].messages.some(m => m.content.includes('First answer')));
        assert.equal(h.calls[1].messages.at(-1)?.content, 'Why is it retained?');
        h.calls[1].fail('synthetic error');
        await settle();
        await h.send('Try again');
        assert.ok(!h.calls[2].messages.some(m => m.content === 'Why is it retained?'));
        assert.equal(h.saved.length, 1);
    } finally { h.close(); }
});

test('a budget-limited chat keeps evidence visible but does not persist it as a completed AI turn', async () => {
    const h=await chatHarness();
    try {
        await h.explain('object');await h.answer(0,'Inspected the selected object');
        await h.send('tell me about this heapdump');
        for(const [offset,tool] of ['object','outbound','referrers'].entries()){
            h.calls[offset+1].chunk(JSON.stringify({action:'read',tool,object_id:'42'}));h.calls[offset+1].done();await settle();await settle();
        }
        assert.ok(h.calls[4].messages.some(m=>m.content.includes('FINAL ANSWER ONLY')));
        h.calls[4].chunk(JSON.stringify({action:'read',tool:'root_path',object_id:'42'}));h.calls[4].done();await settle();await settle();
        assert.equal(h.calls.length,5);assert.equal(h.saved.length,0);
        assert.ok(h.view.messages.some(m=>m.command==='chatDone'&&m.metadataOnly===true));
        assert.ok(h.view.messages.some(m=>m.command==='chatChunk'&&m.text.includes('Metadata summary only')));
        await h.send('A fresh question');assert.ok(!h.calls[5].messages.some(m=>m.content.includes('Metadata summary only')||m.content==='tell me about this heapdump'));
    }finally{h.close();}
});

test('model or endpoint changes drop another destination history', async () => {
    const h = await chatHarness();
    try {
        await h.send('Original question'); await h.answer(0,'Original answer');
        h.config.model = 'different-model';
        await h.send('New question');
        assert.ok(!h.calls[1].messages.some(m => m.content.includes('Original answer')));
        await h.answer(1,'New answer');
        h.config.baseUrl = 'https://different.example.test';
        await h.send('Another endpoint');
        assert.ok(!h.calls[2].messages.some(m => m.content.includes('New answer')));
    } finally { h.close(); }
});

test('clear, close and retry retire in-flight callbacks without saving partial answers', async () => {
    const h = await chatHarness();
    try {
        await h.send('Question before clear');
        const first = h.calls[0];
        first.chunk('Partial'); h.provider.clearChatHistory('/tmp/diagnosis-chat.hprof');
        const count = h.view.messages.length;
        first.chunk('LATE'); first.done();
        assert.equal(first.options.signal?.aborted, true);
        assert.equal(h.view.messages.length, count);
        assert.ok(h.saved.every(value => value === undefined));
        await h.send('Question before retry');
        await h.view.send({ command: 'analyzeRetained' });
        assert.equal(h.calls[1].options.signal?.aborted, true);
        h.calls[1].done();
        await h.send('Question before close');
        const last = h.calls.at(-1);
        assert.ok(last);
        h.view.close();
        assert.equal(last.options.signal?.aborted, true);
        last.chunk('LATE'); last.done();
        assert.ok(h.saved.every(value => value === undefined));
    } finally { h.close(); }
});

test('concurrent sends make one model request and empty answers are not saved', async () => {
    const h = await chatHarness();
    try {
        await Promise.all([h.send('first'), h.send('second')]);
        assert.equal(h.calls.length, 1);
        h.calls[0].done();
        await settle();
        assert.equal(h.saved.length, 0);
        assert.ok(h.view.messages.some(m => m.command === 'chatError' && /empty or oversized/.test(m.message)));
    } finally { h.close(); }
});

test('Cancel consent makes zero provider calls; configuration changes during approval do not redirect data',async()=>{
    const h=await chatHarness();
    try{
        h.setAiDecision(async()=>undefined);await h.send('Declined question');assert.equal(h.calls.length,0);
        h.setAiDecision(async()=>{h.config.baseUrl='https://changed.example.test';return 'Approve this AI session';});
        await h.send('Changed destination');assert.equal(h.calls.length,0);assert.equal(h.saved.length,0);
    }finally{h.close();}
});

test('Chat and Explain accept ordinary answers without requesting JSON output',async()=>{
    const h=await chatHarness();
    try{
        await h.send('What is established?');
        assert.equal(h.calls[0].options.responseFormat,undefined);
        h.calls[0].chunk('Check lifecycle intent; ownership remains a hypothesis.');
        h.calls[0].done();await settle();
        assert.equal(h.saved.length,1);
        assert.ok(h.view.messages.some(m=>m.command==='chatDone'&&m.safeEvidenceAnswer===true));
        await h.explain('object');
        assert.equal(h.calls[1].options.responseFormat,undefined);
        await h.answer(1,'Ownership is a hypothesis.');
        assert.ok(h.view.messages.some(m=>m.command==='explainDone'&&m.safeEvidenceAnswer===true));
    }finally{h.close();}
});

test('Explain uses engine-owned evidence and Stop terminates the matching object/leak channel',async()=>{
    for(const kind of ['object','leak'] as const){
        const h=await chatHarness();
        try{
            await h.explain(kind,{objectId:'42',className:'EngineOwner',retainedSize:999999,fields:[{primitive_value:'PRIVATE_VALUE'}]});
            assert.equal(h.calls.length,1);const body=JSON.stringify(h.calls[0].messages);
            assert.match(body,/EngineOwner/);assert.match(body,/88/);assert.doesNotMatch(body,/999999|PRIVATE_VALUE/);
            await h.view.send({command:'stopAi'});
            assert.equal(h.calls[0].options.signal?.aborted,true);
            assert.ok(h.view.messages.some(m=>m.command===(kind==='object'?'explainError':'explainLeakError')&&/cancelled/.test(m.message)));
            h.calls[0].done();await settle();assert.equal(h.saved.length,0);
        }finally{h.close();}
    }
});

test('server death cancels the answer and blocks new chat until analysis recovers', async () => {
    const h = await chatHarness();
    try {
        await h.send('Question before crash');
        const old = h.calls[0];
        const client = h.provider.getEditorClient('/tmp/diagnosis-chat.hprof') as unknown as FakeServer;
        client.die();
        assert.equal(old.options.signal?.aborted, true);
        const count = h.view.messages.length;
        old.chunk('LATE'); old.done();
        assert.equal(h.view.messages.length, count);
        await h.send('Do not use a dead analysis');
        assert.equal(h.calls.length, 1);
        assert.equal(h.saved.length, 0);
    } finally { h.close(); }
});
test('configuration and credential events immediately revoke consent and abort the active model call',async()=>{
    for(const event of ['configuration','credential']){
        const h=await chatHarness();
        try{
            await h.send('Current destination');assert.equal(h.calls.length,1);
            if(event==='configuration')h.changeAiConfiguration();else h.changeAiCredential();
            assert.equal(h.calls[0].options.signal?.aborted,true);
            h.calls[0].done();await settle();assert.equal(h.saved.length,0);
            h.setAiDecision(async()=>undefined);await h.send('New consent required');assert.equal(h.calls.length,1);
        }finally{h.close();}
    }
});
