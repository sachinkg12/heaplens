import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { EvidenceLedger,investigate,investigationSeed,InvestigationMessage } from './aiInvestigation';
import type { CopilotAnalysisScope } from './copilotScope';
import { completedDiagnosisHistory } from './diagnosisConversation';
import { AiReply, HEAP_READ_TOOL } from './aiToolProtocol';

/** Copilot is a model adapter, not a second unrestricted investigation protocol. */
export function registerChatParticipant(context:vscode.ExtensionContext,capture:()=>CopilotAnalysisScope|null):void {
    // Optional chat APIs must not prevent ordinary heap analysis in another compatible editor.
    if(typeof vscode.chat?.createChatParticipant!=='function' || !vscode.LanguageModelChatMessage)return;
    type Conversation={scope:string;destination:string;ledger:EvidenceLedger;history:InvestigationMessage[];current:()=>boolean};
    const completed=new Map<string,Conversation>(),running=new Map<string,AbortController>();let disposed=false;
    const participant=vscode.chat.createChatParticipant('heaplens.chat',async(request,chatContext,stream,token)=>{
        const scope=capture();if(!scope){stream.markdown('Open a dump and finish retained analysis first.');return;}
        const model=request.model;
        if(!model){scope.dispose();stream.markdown('Choose a model in Copilot Chat. HeapLens will not silently select another provider.');return;}
        const destination=JSON.stringify({vendor:model.vendor,id:model.id,name:model.name,version:model.version});
        if(running.has(scope.identity)){scope.dispose();stream.markdown('Another HeapLens investigation is active for this dump. Stop it first.');return;}
        const controller=new AbortController();running.set(scope.identity,controller);
        const abort=()=>controller.abort();scope.signal.addEventListener('abort',abort,{once:true});const cancel=token.onCancellationRequested(abort);
        if(token.isCancellationRequested || scope.signal.aborted)abort();
        const current=()=>!disposed && !controller.signal.aborted && scope.current();
        // Only our own ephemeral completion token can resolve history; host prose is not evidence.
        let conversation:Conversation|undefined;
        const last=chatContext.history.at(-1);
        if(typeof vscode.ChatResponseTurn==='function' && last instanceof vscode.ChatResponseTurn){const id=last.result.metadata?.heaplensTurn;const prior=typeof id==='string'?completed.get(id):undefined;
            if(prior?.scope===scope.identity && prior.destination===destination && prior.current())conversation={...prior,history:prior.history.map(m=>({...m}))};}
        if(!conversation)conversation={scope:scope.identity,destination,ledger:new EvidenceLedger(scope.identity),history:[],current:scope.current};
        const hasHistory=conversation.history.length>0;
        const question=request.prompt.trim() || (request.command==='leaks'?'Investigate the largest retained objects, without assuming retention proves a leak.':'What does the current heap evidence show?');
        try {
            const result=await investigate({scope:scope.identity,destination,signal:controller.signal,current,
                approve:async()=>await vscode.window.showInformationMessage('Allow HeapLens to share metadata with the selected chat model?',{modal:true,
                    detail:'Dump: '+scope.label+'\nSelected model: '+destination+'\nSends class/field names/types, exact IDs/sizes/counts, bounded references/root paths and your question'+(hasHistory?' plus completed conversation history':'')+'. Raw heap values, source and local paths are excluded. Names/questions may be sensitive. Up to four model calls and three read-only engine reads per question; provider charges may apply. Stop, Retry or closing the dump cancels local work. Previously sent data cannot be recalled.'},'Approve this question')==='Approve this question' && current(),
                read:(action,signal)=>scope.read(action,signal),
                model:async(messages,signal,_timeout,tools)=>{
                    const source=new vscode.CancellationTokenSource();const stop=()=>source.cancel();signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
                    try {
                        const supportsTools=!!(model as typeof model & {capabilities?:{toolCalling?:boolean|number}}).capabilities?.toolCalling && typeof vscode.LanguageModelToolCallPart==='function' && typeof vscode.LanguageModelToolResultPart==='function';
                        const input=messages.map(m=>{
                            if(m.role==='tool')return vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(m.tool_call_id!,[new vscode.LanguageModelTextPart(m.content)])]);
                            if(m.tool_calls)return vscode.LanguageModelChatMessage.Assistant([...(m.content?[new vscode.LanguageModelTextPart(m.content)]:[]),...m.tool_calls.map(c=>new vscode.LanguageModelToolCallPart(c.id,c.name,JSON.parse(c.arguments)))]);
                            return m.role==='assistant'?vscode.LanguageModelChatMessage.Assistant(m.content):vscode.LanguageModelChatMessage.User(m.content);
                        });
                        const response=await model.sendRequest(input,tools&&supportsTools?{tools:[{name:HEAP_READ_TOOL.name,description:HEAP_READ_TOOL.description,inputSchema:HEAP_READ_TOOL.parameters}]}:{},source.token);
                        const reply:AiReply={text:'',toolCalls:[]};
                        if(response.stream){for await(const part of response.stream){
                            if(signal.aborted||!current())throw Error('Investigation cancelled.');
                            if(part instanceof vscode.LanguageModelToolCallPart){reply.toolCalls.push({id:part.callId,name:part.name,arguments:JSON.stringify(part.input)});if(reply.toolCalls.length>3)throw Error('Tool output limit.');}
                            else if(part instanceof vscode.LanguageModelTextPart)reply.text+=part.value;
                            if(reply.text.length>32768)throw Error('Model output limit.');
                        }}else{for await(const chunk of response.text){if(signal.aborted||!current())throw Error('Investigation cancelled.');reply.text+=chunk;if(reply.text.length>32768)throw Error('Model output limit.');}}
                        return reply;
                    }finally{signal.removeEventListener('abort',stop);source.dispose();}
                },progress:message=>{if(current())stream.progress(message);}
            },conversation.ledger,question,investigationSeed(scope.data.summary,scope.data.topObjects,scope.data.classHistogram),conversation.history);
            if(!current())return;
            const literal=new vscode.MarkdownString();literal.isTrusted=false;literal.supportHtml=false;literal.appendText(result.text);stream.markdown(literal);
            if(result.evidence.length)stream.markdown('AI interpretation may be wrong. Evidence links contain engine metadata, not proof of a cause or repair.');
            if(!result.metadataOnly)conversation.history=completedDiagnosisHistory([...conversation.history,{role:'user',content:question},{role:'assistant',content:result.text}]);
            const id=randomBytes(16).toString('hex');completed.set(id,{...conversation,history:conversation.history.map(m=>({...m}))});while(completed.size>32)completed.delete(completed.keys().next().value as string);
            for(const record of result.evidence)stream.button({command:'heaplens.showCopilotEvidence',title:'View evidence: '+record.operation,arguments:[id,record.id]});
            return {metadata:{heaplensTurn:id,scope:scope.identity,metadataOnly:!!result.metadataOnly}};
        } catch {if(!disposed)stream.markdown('Investigation cancelled, changed, invalid or over its limit. No complete answer claimed; no automatic retry was made.');}
        finally{cancel.dispose();scope.signal.removeEventListener('abort',abort);running.delete(scope.identity);scope.dispose();}
    });
    context.subscriptions.push(participant,vscode.commands.registerCommand('heaplens.showCopilotEvidence',async(token:unknown,id:unknown)=>{
        const record=typeof token==='string'?completed.get(token):undefined;
        if(!record || !record.current() || typeof id!=='string'){vscode.window.showWarningMessage('Evidence expired. Run the investigation again.');return;}
        try{const document=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(record.ledger.get(id),null,2)});if(record.current())await vscode.window.showTextDocument(document,{preview:true});}
        catch{vscode.window.showWarningMessage('Evidence is unavailable in this investigation.');}
    }),{dispose:()=>{disposed=true;running.forEach(c=>c.abort());running.clear();completed.clear();}});
    participant.iconPath=new vscode.ThemeIcon('search');
}
