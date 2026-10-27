package com.heaplens.ai;

import com.google.gson.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.*;
import java.util.regex.*;

/** One bounded owner for native Chat and Explain; model/consent/engine ports are replaceable. */
public final class AiInvestigation implements AutoCloseable {
    private static final Gson RESPONSE_JSON=new GsonBuilder().setStrictness(Strictness.STRICT).create();
    private static final String SPACE="[\\x09-\\x0d\\x20\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";
    private static final Pattern FENCE=Pattern.compile("^```(?:json)?[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```$",Pattern.CASE_INSENSITIVE);
    /** Presentation only, shared across providers; never extract or repair JSON inside prose. */
    static JsonObject parseResponse(String value){
        if(value.length()>32768)throw new IllegalArgumentException("Investigation response limit");
        String text=value.replaceAll("^"+SPACE+"+|"+SPACE+"+$","");
        Matcher fence=FENCE.matcher(text);if(fence.matches())text=fence.group(1);
        JsonObject response=RESPONSE_JSON.fromJson(text,JsonObject.class);
        if(response==null)throw new IllegalArgumentException("Complete investigation object required");
        return response;
    }
    private final AiHostPort host;private final LlmTransport transport;private final InvestigationEngine.Capture capture;
    private final BooleanSupplier ready;private final Consumer<JsonObject> output;private final ChatHistoryStore store;
    private final ExecutorService worker=new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(1),r->{Thread t=new Thread(r,"heaplens-investigation");t.setDaemon(true);return t;},new ThreadPoolExecutor.AbortPolicy());
    private final ScheduledExecutorService clock=Executors.newSingleThreadScheduledExecutor(r->{Thread t=new Thread(r,"heaplens-investigation-deadline");t.setDaemon(true);return t;});
    private final AutoCloseable configurationListener;
    private JsonObject data;private InvestigationEvidence ledger;private InvestigationEngine ledgerEngine;private String grant;private volatile long generation;private volatile boolean closed;private boolean configuring;
    private final List<LlmTransport.Message> history=new ArrayList<>();private Turn current;
    private static final class InvestigationFailure extends RuntimeException {
        InvestigationFailure(String safeMessage){super(safeMessage);}
    }
    static String stepPolicy(int call,int reads){
        int remaining=Math.max(0,InvestigationEvidence.limit("reads")-reads);
        if(call==InvestigationEvidence.limit("modelCalls") || remaining==0)return "Investigation budget: FINAL ANSWER ONLY. No additional reads are available. Answer naturally using existing evidence and state missing information. Do not request another tool call.";
        return "Investigation budget: model step "+call+"/"+InvestigationEvidence.limit("modelCalls")+"; "+remaining+" read(s) available. Prefer answering from the supplied summary and rows for an overview question. Read only if a specific missing fact requires it; do not spend the budget merely because tools are available.";
    }
    private static final class Turn {
        final String id,channel,question,selected,className;final long epoch;final AtomicBoolean cancelled=new AtomicBoolean();
        final Set<String> jobs=ConcurrentHashMap.newKeySet();volatile InvestigationEngine engine;volatile LlmTransport.Call call;volatile Future<?> task;volatile ScheduledFuture<?> timer;volatile CompletableFuture<Boolean> permission;
        Turn(String id,String channel,String question,String selected,String className,long epoch){this.id=id;this.channel=channel;this.question=question;this.selected=selected;this.className=className;this.epoch=epoch;}
    }
    public AiInvestigation(AiHostPort host,LlmTransport transport,InvestigationEngine.Capture capture,BooleanSupplier ready,Consumer<JsonObject> output,ChatHistoryStore store){
        this.host=host;this.transport=transport;this.capture=capture;this.ready=ready;this.output=output;this.store=store;configurationListener=host.onConfigurationChange(this::settingsChanged);
    }
    public synchronized boolean busy(){return current!=null || configuring;}
    public synchronized void analysis(JsonObject value){
        invalidate();data=value.deepCopy();long epoch=generation;
        submit(()->{ChatHistoryStore.Entry saved=store.load();synchronized(this){if(!closed && epoch==generation && !saved.messages().isEmpty()){JsonObject e=event("aiHistory");e.add("messages",new Gson().toJsonTree(saved.messages()));output.accept(e);}}});
    }
    public synchronized void unavailable(){invalidate();data=null;}
    public synchronized void invalidate(){stop();generation++;grant=null;ledger=null;history.clear();}
    private synchronized void settingsChanged(){invalidate();}
    public synchronized void clear(){invalidate();long epoch=generation;emit(event("aiReset"));if(!submit(()->{try{if(!closed && epoch==generation)store.clear();}catch(RuntimeException failure){clearFailed();}}))clearFailed();}
    private void clearFailed(){JsonObject status=event("aiHistoryStatus");status.addProperty("message","Local history could not be removed. Retry Clear.");emit(status);}
    public synchronized void send(JsonObject message){begin(message,"ai",InvestigationEvidence.text(message,"text"),null,null,null);}
    public synchronized void explain(JsonObject message){
        String selected=InvestigationEvidence.pageId(message.get("objectId"));
        begin(message,"explain","Explain selected object "+selected+" using actual engine evidence; retention alone is not proof of a leak.",selected,null,null);
    }
    public synchronized void explainLeak(JsonObject message){
        String name=InvestigationEvidence.text(message,"className");if(name.length()>10000)throw new IllegalArgumentException("Invalid class label");
        String selected=message.has("objectId") && !message.get("objectId").getAsString().equals("0")?InvestigationEvidence.pageId(message.get("objectId")):null;
        JsonObject group=null;if(selected==null && data!=null && data.has("classHistogram"))for(JsonElement row:data.getAsJsonArray("classHistogram"))if(name.equals(row.getAsJsonObject().get("class_name").getAsString())){group=row.getAsJsonObject();break;}
        if(selected==null && group==null)throw new IllegalArgumentException("Selection unavailable");
        begin(message,"explainLeak",selected==null?"Explain this class group, not a single object or a proven leak: "+name.substring(0,Math.min(512,name.length())):"Explain selected object "+selected+"; retention is not a proven leak.",selected,name,group);
    }
    private void begin(JsonObject message,String channel,String question,String selected,String className,JsonObject group){
        String id=InvestigationEvidence.text(message,"requestId");if(!id.matches("[A-Za-z0-9_-]{1,80}"))throw new IllegalArgumentException("Invalid request ID");
        Turn turn=new Turn(id,channel,question,selected,className,generation);
        if(closed || data==null || !ready.getAsBoolean() || busy() || question.isBlank() || question.length()>4000){emit(turn,"Error","Wait for retained analysis and the current action; use 1–4,000 characters.");return;}
        current=turn;JsonObject seed=InvestigationEvidence.seed(data,group);
        turn.timer=clock.schedule(()->finish(turn,"Investigation deadline exceeded. No complete answer claimed."),InvestigationEvidence.limit("totalMs"),TimeUnit.MILLISECONDS);
        try{turn.task=worker.submit(()->run(turn,seed));}catch(RejectedExecutionException busy){finish(turn,"The previous action is still stopping. Retry shortly.");}
    }
    private synchronized boolean active(Turn turn){return !closed && current==turn && generation==turn.epoch && !turn.cancelled.get() && ready.getAsBoolean() && (turn.engine==null || turn.engine.current());}
    private void check(Turn turn){if(!active(turn))throw new CancellationException("Investigation changed or cancelled");}
    private void run(Turn turn,JsonObject seed){
        try{
            check(turn);turn.engine=capture.capture().get(3,TimeUnit.SECONDS);check(turn);
            AiConfiguration config=host.loadConfiguration();check(turn);String approved=config.chatApprovalScope();
            InvestigationEvidence evidence;boolean needsApproval;
            synchronized(this){check(turn);if(ledger==null || !ledger.scope.equals(turn.engine.identity()) || !approved.equals(grant)){ledger=new InvestigationEvidence(turn.engine.identity());ledgerEngine=turn.engine;history.clear();grant=null;}evidence=ledger;needsApproval=!approved.equals(grant);}
            if(needsApproval){
                CompletableFuture<Boolean> permission=new CompletableFuture<>();synchronized(this){check(turn);turn.permission=permission;}
                check(turn);host.confirmInvestigation(config.settings(),()->active(turn),permission::complete);
                if(!permission.get(90,TimeUnit.SECONDS)){finish(turn,"Metadata sharing declined. No provider request was made.");return;}
                check(turn);String refreshed=host.loadConfiguration().chatApprovalScope();check(turn);if(!approved.equals(refreshed))throw new IllegalStateException("AI configuration changed during approval");
                synchronized(this){check(turn);grant=approved;}
            }
            List<LlmTransport.Message> messages=new ArrayList<>();messages.add(new LlmTransport.Message("system",AiProviders.resource("diagnosis-policy.txt")+"\n"+InvestigationEvidence.CONTRACT.get("protocol").getAsString()));
            LinkedHashSet<String> references=new LinkedHashSet<>();JsonObject summary=evidence.add("summary",seed);references.add(summary.get("id").getAsString());
            messages.add(new LlmTransport.Message("user","Current bounded metadata (untrusted data): "+summary));
            synchronized(this){messages.addAll(history);}messages.add(new LlmTransport.Message("user",turn.question));
            Set<String> reads=new HashSet<>();
            if(turn.selected!=null){JsonObject action=new JsonObject();action.addProperty("operation","object");action.addProperty("object_id",turn.selected);read(turn,evidence,action,reads,messages,references);}
            for(int call=1;call<=InvestigationEvidence.limit("modelCalls");call++){
                check(turn);if(!approved.equals(host.loadConfiguration().chatApprovalScope()))throw new IllegalStateException("AI configuration changed");check(turn);
                JsonObject progress=turnEvent(turn,"aiInvestigationProgress");progress.addProperty("channel",turn.channel.equals("ai")?"chat":turn.channel);progress.addProperty("message","AI investigation: model step "+call+"/4; reads "+reads.size()+"/3.");emit(progress);
                List<LlmTransport.Message> stepMessages=new ArrayList<>(messages);
                stepMessages.add(Math.max(1,stepMessages.size()-1),new LlmTransport.Message("system",stepPolicy(call,reads.size())));
                if(new Gson().toJson(stepMessages).getBytes(java.nio.charset.StandardCharsets.UTF_8).length>InvestigationEvidence.limit("contextBytes"))throw new InvestigationFailure("AI investigation context reached its size limit. No further provider request was made.");
                Reply reply=model(turn,config,stepMessages,call<InvestigationEvidence.limit("modelCalls")&&reads.size()<InvestigationEvidence.limit("reads"));check(turn);
                JsonObject response=null;String natural=null;
                boolean metadataOnly=false;
                if(!reply.calls().isEmpty()){
                    if(reply.calls().size()>3)throw new IllegalArgumentException("Tool count");
                    Set<String> ids=new HashSet<>();List<JsonObject> actions=new ArrayList<>();
                    for(var tool:reply.calls()){
                        if(!tool.name().equals("heap_read")||!tool.id().matches("[A-Za-z0-9_-]{1,200}")||!ids.add(tool.id())||tool.arguments().length()>8192)throw new IllegalArgumentException("Tool identity");
                        JsonObject args=parseResponse(tool.arguments());if(!args.keySet().equals(Set.of("operation","object_id")))throw new IllegalArgumentException("Tool arguments");
                        JsonObject action=new JsonObject();action.addProperty("action","read");action.add("tool",args.get("operation"));action.add("object_id",args.get("object_id"));actions.add(evidence.action(action));
                    }
                    if(call==InvestigationEvidence.limit("modelCalls") || reads.size()+actions.size()>InvestigationEvidence.limit("reads")){
                        response=evidence.budgetSummary(summary,turn.selected,references);metadataOnly=true;
                    }else{
                        messages.add(new LlmTransport.Message("assistant",reply.text(),reply.calls(),null));
                        for(int i=0;i<actions.size();i++){read(turn,evidence,actions.get(i),reads,messages,references);var result=messages.removeLast();messages.add(new LlmTransport.Message("tool",result.content(),null,reply.calls().get(i).id()));}continue;
                    }
                }else{
                    // Reads stay in the scoped ledger, but only citations belong under this reply.
                    references.clear();natural=naturalAnswer(reply.text(),evidence,references);
                }
                {
                    String rendered=natural!=null?natural:"Metadata summary only — the model requested more reads after the investigation budget was exhausted. This is not a completed AI diagnosis.\n\n"+evidence.answer(response,references);check(turn);JsonArray links=new JsonArray();for(String id:references){JsonObject record=evidence.get(id),link=new JsonObject();link.addProperty("id",id);link.add("operation",record.get("operation"));links.add(link);}
                    ChatHistoryStore.Entry saved=null;
                    synchronized(this){check(turn);emit(turn,"Chunk",rendered);JsonObject done=turnEvent(turn,turn.channel+"Done");done.addProperty("safeEvidenceAnswer",true);done.addProperty("metadataOnly",metadataOnly);done.add("evidence",links);done.addProperty("modelCalls",call);done.addProperty("reads",reads.size());emit(done);
                        if(turn.channel.equals("ai") && !metadataOnly){history.add(new LlmTransport.Message("user",turn.question));history.add(new LlmTransport.Message("assistant",rendered));while(history.size()>8 || history.stream().mapToInt(m->m.content().length()).sum()>24000){history.removeFirst();history.removeFirst();}
                            saved=new ChatHistoryStore.Entry(config.settings().toString(),List.copyOf(history));}
                        current=null;turn.timer.cancel(false);}
                    // Same worker serializes this write before any subsequently queued Clear/load.
                    if(saved!=null)try{if(!closed && generation==turn.epoch)store.save(saved);}catch(RuntimeException failure){JsonObject status=event("aiHistoryStatus");status.addProperty("message","Answer completed; local history could not be saved.");emit(status);}return;
                }
            }
        }catch(Exception failure){
            String message=failure instanceof InvestigationFailure?failure.getMessage()
                :failure instanceof CancellationException || failure instanceof InterruptedException?"AI investigation cancelled or the originating analysis changed."
                :failure instanceof TimeoutException?"AI investigation timed out while waiting for approval or the analysis session. No automatic retry was made."
                :failure instanceof IllegalArgumentException || failure instanceof JsonParseException?"AI response or evidence failed validation. No complete AI answer was accepted; no automatic retry was made."
                :"AI investigation could not complete. No complete AI answer was accepted; no automatic retry was made.";
            finish(turn,message);
        }
    }
    private record Reply(String text,List<LlmTransport.ToolCall> calls) { }
    static String naturalAnswer(String text,InvestigationEvidence evidence,Set<String> references){
        if(text.isBlank()||text.length()>32768)throw new IllegalArgumentException("Empty or oversized answer");
        Matcher handles=Pattern.compile("\\[(E[a-f0-9]{12}_[1-9][0-9]{0,3})\\]").matcher(text);
        while(handles.find()){evidence.get(handles.group(1));references.add(handles.group(1));}return text.strip();
    }
    private Reply model(Turn turn,AiConfiguration config,List<LlmTransport.Message> messages,boolean tools)throws Exception{
        CompletableFuture<Reply> result=new CompletableFuture<>();StringBuilder answer=new StringBuilder();List<LlmTransport.ToolCall> calls=new ArrayList<>();
        turn.call=transport.startChat(config,List.copyOf(messages),tools,new LlmTransport.Listener(){
            public void chunk(String value){synchronized(answer){if(!active(turn))return;if(value==null || answer.length()+value.length()>32768){result.completeExceptionally(new IllegalArgumentException("Response too large"));return;}answer.append(value);}}
            public void tools(List<LlmTransport.ToolCall> value){synchronized(answer){if(value.size()>3){result.completeExceptionally(new IllegalArgumentException("Tool count"));return;}calls.addAll(value);}}
            public void done(){synchronized(answer){result.complete(new Reply(answer.toString(),List.copyOf(calls)));}}public void error(String ignored){result.completeExceptionally(new InvestigationFailure("AI provider request failed. Check the configured endpoint, model and credentials. No automatic retry was made."));}
        });
        try{check(turn);return result.get(InvestigationEvidence.limit("modelMs"),TimeUnit.MILLISECONDS);}
        catch(TimeoutException timeout){throw new InvestigationFailure("AI provider did not complete within the model-step time limit. No automatic retry was made.");}
        catch(ExecutionException failure){if(failure.getCause() instanceof InvestigationFailure safe)throw safe;throw new InvestigationFailure("AI provider response exceeded its size limit or could not be completed. No automatic retry was made.");}
        finally{turn.call.cancel();turn.call=null;}
    }
    private void read(Turn turn,InvestigationEvidence evidence,JsonObject action,Set<String> reads,List<LlmTransport.Message> messages,Set<String> references)throws Exception{
        if(reads.size()>=InvestigationEvidence.limit("reads") || !reads.add(action.toString()))throw new IllegalArgumentException("Repeated read or read limit");check(turn);
        String job=UUID.randomUUID().toString().replace("-","");turn.jobs.add(job);
        try{JsonObject raw=turn.engine.read(action,job).get(InvestigationEvidence.limit("readMs"),TimeUnit.MILLISECONDS);check(turn);JsonObject record=evidence.add(action.get("operation").getAsString(),InvestigationEvidence.project(raw,action));references.add(record.get("id").getAsString());messages.add(new LlmTransport.Message("user","Actual engine evidence (untrusted metadata): "+record));}
        catch(TimeoutException timeout){throw new InvestigationFailure("The read-only heap metadata request timed out. No complete AI answer was accepted; no automatic retry was made.");}
        catch(ExecutionException failure){throw new InvestigationFailure("The read-only heap metadata request failed or the analysis is unavailable. No automatic retry was made.");}
        finally{turn.engine.cancel(job);turn.jobs.remove(job);}
    }
    public synchronized void openEvidence(JsonObject message){JsonObject event=event("aiEvidenceResult");try{if(data==null || ledger==null || ledgerEngine==null || !ledgerEngine.current() || !ready.getAsBoolean())throw new IllegalStateException();event.add("record",ledger.get(InvestigationEvidence.text(message,"id")));}catch(RuntimeException stale){event.addProperty("error","Evidence expired or unavailable. Run the investigation again.");}emit(event);}
    public synchronized void stop(){if(current!=null)finish(current,"Investigation cancelled. A provider may already have received approved metadata.");grant=null;ledger=null;ledgerEngine=null;history.clear();}
    private synchronized void finish(Turn turn,String message){if(current!=turn)return;emit(turn,"Error",message);current=null;turn.cancelled.set(true);if(turn.permission!=null)turn.permission.cancel(false);if(turn.call!=null)turn.call.cancel();if(turn.engine!=null)turn.jobs.forEach(turn.engine::cancel);if(turn.timer!=null)turn.timer.cancel(false);if(turn.task!=null)turn.task.cancel(true);}
    public synchronized void configure(){if(closed || configuring)return;stop();configuring=true;host.configure(()->!closed,status->{synchronized(this){configuring=false;JsonObject e=event("aiConfiguration");e.addProperty("message",status);emit(e);}});}
    private boolean submit(Runnable task){try{worker.execute(task);return true;}catch(RejectedExecutionException busy){return false;}}
    private static JsonObject event(String command){JsonObject e=new JsonObject();e.addProperty("command",command);return e;}
    private JsonObject turnEvent(Turn turn,String command){JsonObject e=event(command);e.addProperty("requestId",turn.id);if(turn.selected!=null)e.addProperty("objectId",turn.selected);if(turn.className!=null)e.addProperty("className",turn.className);return e;}
    private void emit(Turn turn,String suffix,String value){JsonObject e=turnEvent(turn,turn.channel+suffix);e.addProperty(suffix.equals("Chunk")?"text":"message",value);emit(e);}
    private synchronized void emit(JsonObject event){if(!closed)output.accept(event);}
    @Override public synchronized void close(){if(closed)return;invalidate();closed=true;worker.shutdownNow();clock.shutdownNow();transport.close();try{configurationListener.close();}catch(Exception ignored){}}
}
