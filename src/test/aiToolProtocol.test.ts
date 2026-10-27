import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import {ToolCallCollector,wireMessages,wireTools} from '../aiToolProtocol';
import {callLlmFull,callLlmChat,supportsChatTools} from '../llmClient';

test('both wire formats preserve native call IDs, exact arguments and tool results',()=>{
    const messages=[{role:'assistant' as const,content:'Inspecting',tool_calls:[{id:'call_A',name:'heap_read',arguments:'{"operation":"object","object_id":"9007199254740993"}'}]},
        {role:'tool' as const,tool_call_id:'call_A',content:'Actual engine evidence (untrusted metadata): {"retained_size":"88"}'}];
    const compatible=wireMessages(messages,false) as any[],anthropic=wireMessages(messages,true) as any[];
    assert.equal(compatible[0].tool_calls[0].function.name,'heap_read');assert.equal(compatible[1].tool_call_id,'call_A');
    assert.equal(anthropic[0].content[1].input.object_id,'9007199254740993');assert.equal(anthropic[1].content[0].tool_use_id,'call_A');
    assert.equal((wireTools(false,true) as any).tool_choice,'auto');assert.deepEqual(wireTools(true,false),{});
});
test('compatible SSE accumulates fragmented tool names and JSON without parsing prose',()=>{
    const c=new ToolCallCollector();
    for(const item of [{index:0,id:'call_A',type:'function',function:{name:'heap_',arguments:'{"operation":'}},
        {index:0,function:{name:'read',arguments:'"object","object_id":"42"}'}}])c.consume({choices:[{delta:{content:'Plain prose',tool_calls:[item]}}]},false);
    assert.deepEqual(c.finish(),[{id:'call_A',name:'heap_read',arguments:'{"operation":"object","object_id":"42"}'}]);
});
test('Anthropic SSE separates text blocks from incremental tool input',()=>{
    const c=new ToolCallCollector();c.consume({type:'content_block_start',index:1,content_block:{type:'tool_use',id:'call_A',name:'heap_read',input:{}}},true);
    for(const part of ['{"operation":"root_','path","object_id":"42"}'])c.consume({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:part}},true);
    assert.equal(JSON.parse(c.finish()[0].arguments).operation,'root_path');
});
test('malformed, duplicate, oversized and too-many tool calls fail before engine invocation',()=>{
    for(const index of [-1,.5,32,'0'])assert.throws(()=>new ToolCallCollector().consume({choices:[{delta:{tool_calls:[{index}]}}]},false));
    const c=new ToolCallCollector();c.consume({choices:[{delta:{tool_calls:[{index:0,id:'x',function:{name:'heap_read',arguments:'not JSON'}}]}}]},false);assert.throws(()=>c.finish());
    const many=new ToolCallCollector();for(let i=0;i<3;i++)many.consume({choices:[{delta:{tool_calls:[{index:i,id:'id'+i,function:{name:'heap_read',arguments:'{}'}}]}}]},false);
    assert.throws(()=>many.consume({choices:[{delta:{tool_calls:[{index:3}]}}]},false));
    assert.throws(()=>new ToolCallCollector().consume({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'x'.repeat(8193)}}]}}]},false));
});
test('unknown/local model profiles keep text Chat rather than receiving speculative tool options',()=>{
    assert.equal(supportsChatTools({provider:'openai',apiKey:'synthetic'}),true);
    for(const config of [{provider:'openai',apiKey:'',model:'unknown'},{provider:'openai',apiKey:'',baseUrl:'https://proxy.test'},{provider:'ollama',apiKey:''},{provider:'openrouter',apiKey:''}])assert.equal(supportsChatTools(config),false);
});
test('real HTTP streams return native tool parts separately for both protocol families',async()=>{
    for(const provider of ['openai','anthropic']){
        let body:any,calls:any;
        const server=http.createServer(async(req,res)=>{let input='';for await(const chunk of req)input+=chunk;body=JSON.parse(input);res.writeHead(200,{'Content-Type':'text/event-stream'});
            const events=provider==='anthropic'?[{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'call_A',name:'heap_read',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"operation":"object","object_id":"42"}'}},{type:'message_stop'}]:[{choices:[{delta:{tool_calls:[{index:0,id:'call_A',type:'function',function:{name:'heap_read',arguments:'{"operation":"object",'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"object_id":"42"}'}}]},finish_reason:'tool_calls'}]}];
            for(const event of events)res.write('data: '+JSON.stringify(event)+'\n\n');res.end('data: [DONE]\n\n');});
        await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
        try{const baseUrl='http://127.0.0.1:'+(server.address() as any).port;
            const text=await callLlmFull({provider,baseUrl,apiKey:'SYNTHETIC'},[{role:'user',content:'Inspect'}],{tools:true,onTools:value=>{calls=value;}});
            assert.equal(text,'');assert.equal(calls[0].name,'heap_read');assert.equal(JSON.parse(calls[0].arguments).object_id,'42');assert.equal(body.tools.length,1);
            await assert.rejects(callLlmChat({provider,baseUrl,apiKey:'SYNTHETIC'},[{role:'user',content:'Inspect'}]),/unoffered/);
        }finally{await new Promise<void>(r=>server.close(()=>r()));}
    }
});
