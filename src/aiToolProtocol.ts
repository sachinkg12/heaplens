/** Native tool traffic is separate from human-readable answers. No JSON is extracted from prose. */
export interface AiToolCall { id: string; name: string; arguments: string }
export interface AiReply { text: string; toolCalls: AiToolCall[] }
export interface AiMessage { role: 'system'|'user'|'assistant'|'tool'; content: string; tool_calls?: AiToolCall[]; tool_call_id?: string }
export const HEAP_READ_TOOL = Object.freeze({ name:'heap_read', description:'Read bounded metadata for an exact object ID already supplied by this heap. No raw values, queries, files or writes.',
    parameters:{type:'object',properties:{operation:{type:'string',enum:['object','fields','outbound','referrers','children','root_path']},object_id:{type:'string',pattern:'^[1-9][0-9]{0,19}$'}},required:['operation','object_id'],additionalProperties:false} });
export function wireMessages(messages: readonly AiMessage[], anthropic: boolean): unknown[] {
    return messages.filter(m=>!anthropic || m.role!=='system').map(m=>{
        if(!anthropic) return {...m,...(m.tool_calls?{tool_calls:m.tool_calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:c.arguments}}))}:{})};
        if(m.role==='tool')return {role:'user',content:[{type:'tool_result',tool_use_id:m.tool_call_id,content:m.content}]};
        if(m.tool_calls)return {role:'assistant',content:[...(m.content?[{type:'text',text:m.content}]:[]),...m.tool_calls.map(c=>({type:'tool_use',id:c.id,name:c.name,input:JSON.parse(c.arguments)}))]};
        return {role:m.role,content:m.content};
    });
}
export function wireTools(anthropic:boolean, enabled:boolean): Record<string,unknown> {
    if(!enabled)return {};
    return anthropic?{tools:[{name:HEAP_READ_TOOL.name,description:HEAP_READ_TOOL.description,input_schema:HEAP_READ_TOOL.parameters}]}:
        {tools:[{type:'function',function:HEAP_READ_TOOL}],tool_choice:'auto'};
}
/** Accumulate indexed SSE fragments with finite memory, then validate before exposing any call. */
export class ToolCallCollector {
    private readonly calls=new Map<number,AiToolCall>();
    consume(event:any,anthropic:boolean):void {
        const add=(index:unknown,id:unknown,name:unknown,args:unknown)=>{
            if(!Number.isInteger(index)||Number(index)<0||Number(index)>31)throw Error('Invalid tool index.');
            const key=Number(index),c=this.calls.get(key)||{id:'',name:'',arguments:''};
            if(!this.calls.has(key)&&this.calls.size>=3)throw Error('Too many model tool calls.');
            for(const [field,value] of [['id',id],['name',name],['arguments',args]] as const){
                if(value===undefined)continue;if(typeof value!=='string')throw Error('Invalid tool fragment.');c[field]+=value;
            }
            if(c.id.length>200||c.name.length>80||c.arguments.length>8192)throw Error('Tool arguments exceed limits.');
            this.calls.set(key,c);
        };
        if(anthropic){
            if(event.type==='content_block_start'&&event.content_block?.type==='tool_use'){
                const block=event.content_block;add(event.index,block.id,block.name,block.input&&Object.keys(block.input).length?JSON.stringify(block.input):'');
            }
            if(event.type==='content_block_delta'&&event.delta?.type==='input_json_delta')add(event.index,undefined,undefined,event.delta.partial_json);
        }else{
            const calls=event.choices?.[0]?.delta?.tool_calls;
            if(calls!==undefined){if(!Array.isArray(calls))throw Error('Invalid tool calls.');for(const c of calls){if(c.type!==undefined&&c.type!=='function')throw Error('Unsupported tool type.');add(c.index,c.id,c.function?.name,c.function?.arguments);}}
        }
    }
    finish():AiToolCall[]{
        const result=[...this.calls.values()];const ids=new Set<string>();
        for(const c of result){if(!/^[A-Za-z0-9_-]{1,200}$/.test(c.id)||!c.name||ids.has(c.id))throw Error('Invalid or duplicate tool call.');ids.add(c.id);JSON.parse(c.arguments);}
        return result;
    }
}
