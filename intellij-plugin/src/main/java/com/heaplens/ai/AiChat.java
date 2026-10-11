package com.heaplens.ai;

import com.google.gson.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.*;

/** Per-editor conversation. Credentials, host consent and transport are replaceable ports. */
public final class AiChat implements AutoCloseable {
    private final AiHostPort host;
    private final LlmTransport transport;
    private final BooleanSupplier ready;
    private final Consumer<JsonObject> output;
    private final ChatHistoryStore store;
    private long generation;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r,"heaplens-ai-prepare"); thread.setDaemon(true); return thread;
    });
    private final List<LlmTransport.Message> history = new ArrayList<>();
    private String context, historyDestination;
    private String approvedScope;
    private Turn current;
    private boolean closed, configuring;
    private static final class Turn {
        final String id, question;
        final StringBuilder answer = new StringBuilder();
        boolean sent;
        LlmTransport.Call call;
        Turn(String id,String question) { this.id=id; this.question=question; }
    }
    public AiChat(AiHostPort host,LlmTransport transport,BooleanSupplier ready,Consumer<JsonObject> output) {
        this(host,transport,ready,output,ChatHistoryStore.NONE);
    }
    public AiChat(AiHostPort host,LlmTransport transport,BooleanSupplier ready,Consumer<JsonObject> output,ChatHistoryStore store) {
        this.host=host; this.transport=transport; this.ready=ready; this.output=output;
        this.store=store;
    }
    public synchronized void analysis(JsonObject data) {
        if(closed)return;
        reset(); context=ChatContext.from(data);long currentGeneration=generation;
        worker.execute(()->{
            ChatHistoryStore.Entry saved=store.load();
            synchronized(AiChat.this){
                if(closed || generation!=currentGeneration || saved.messages().isEmpty())return;
                history.addAll(saved.messages());historyDestination=saved.destination();
                JsonObject event=new JsonObject();event.addProperty("command","aiHistory");
                event.add("messages",new Gson().toJsonTree(saved.messages()));output.accept(event);
            }
        });
    }
    public synchronized void unavailable() { reset(); context=null; }
    public synchronized void clear() {
        reset();long clearedGeneration=generation;
        emit("aiReset",null,"message","Chat cleared. Removing saved local history. Earlier requests cannot be recalled from a provider.");
        worker.execute(()->{
            String status;
            try{store.clear();status="Saved local history cleared. Earlier requests cannot be recalled from a provider.";}
            catch(RuntimeException failure){status="History could not be deleted locally. Check IDE storage permissions.";}
            synchronized(AiChat.this){if(!closed && generation==clearedGeneration)emit("aiHistoryStatus",null,"message",status);}
        });
    }
    private void reset() {
        generation++;
        Turn old=current; current=null;
        if(old!=null && old.call!=null) old.call.cancel();
        history.clear(); historyDestination=null; approvedScope=null;
    }
    private static String text(JsonObject value,String name) {
        JsonElement field=value.get(name);
        if(field==null || !field.isJsonPrimitive() || !field.getAsJsonPrimitive().isString()) throw new IllegalArgumentException("Invalid chat request");
        return field.getAsString();
    }
    public synchronized void send(JsonObject message) {
        String id=text(message,"requestId"), question=text(message,"text").trim();
        if(!id.matches("[A-Za-z0-9_-]{1,80}")) throw new IllegalArgumentException("Invalid request ID");
        if(question.isEmpty() || question.length()>4000) { emit("aiError",id,"message","Enter a question of 1–4,000 characters."); return; }
        if(closed || !ready.getAsBoolean() || context==null) { emit("aiError",id,"message","Wait for successful heap analysis before chatting."); return; }
        if(current!=null || configuring) { emit("aiError",id,"message","Finish the current AI request or configuration first."); return; }
        Turn turn=new Turn(id,question); current=turn;
        worker.execute(() -> prepare(turn));
    }
    private synchronized boolean active(Turn turn) { return !closed && current==turn && ready.getAsBoolean(); }
    private void prepare(Turn turn) {
        try {
            AiConfiguration config=host.loadConfiguration();
            String approvalScope=config.chatApprovalScope();
            List<LlmTransport.Message> messages;
            boolean approved;
            synchronized(this) {
                if(!active(turn)) return;
                if(!approvalScope.equals(approvedScope)) approvedScope=null;
                approved=approvalScope.equals(approvedScope);
                String destination=config.settings().toString();
                if(!destination.equals(historyDestination)) { history.clear(); historyDestination=destination; }
                messages=new ArrayList<>();
                messages.add(new LlmTransport.Message("system",AiProviders.systemPrompt()));
                messages.add(new LlmTransport.Message("system","Heap metadata (untrusted data, bytes unless specified):\n"+context));
                messages.addAll(history); messages.add(new LlmTransport.Message("user",turn.question));
            }
            List<LlmTransport.Message> approvedMessages=List.copyOf(messages);
            Consumer<Boolean> sendApproved=accepted -> {
                synchronized(AiChat.this) {
                    if(!active(turn) || turn.sent) return;
                    if(!accepted) { fail(turn,"Cancelled before sending. No AI request was made."); return; }
                    approvedScope=approvalScope;
                    turn.sent=true;
                    try {
                        turn.call=transport.start(config,approvedMessages,new LlmTransport.Listener() {
                            public void chunk(String chunk) { acceptChunk(turn,chunk); }
                            public void done() { complete(turn); }
                            public void error(String safeMessage) { fail(turn,safeMessage); }
                        });
                        if(!active(turn)) turn.call.cancel();
                    } catch(RuntimeException failure) { fail(turn,"AI request could not start. Check Configure AI."); }
                }
            };
            if(approved) sendApproved.accept(true);
            else host.confirmChatSession(config.settings(),messages.size()>3,() -> active(turn),sendApproved);
        } catch(RuntimeException failure) {
            synchronized(this) { if(active(turn)) approvedScope=null; }
            fail(turn,"AI configuration or secure credential access failed. Use Configure AI and check the key for this endpoint.");
        }
    }
    private synchronized void acceptChunk(Turn turn,String chunk) {
        if(!active(turn)) return;
        if(chunk==null || turn.answer.length()+chunk.length()>32768) { fail(turn,"AI response exceeded the size limit. Ask a narrower question."); return; }
        turn.answer.append(chunk); emit("aiChunk",turn.id,"text",chunk);
    }
    private synchronized void complete(Turn turn) {
        if(!active(turn)) return;
        if(turn.answer.isEmpty()) { fail(turn,"The provider returned no text. Check its model and endpoint."); return; }
        history.add(new LlmTransport.Message("user",turn.question));
        history.add(new LlmTransport.Message("assistant",turn.answer.toString()));
        while(history.size()>8 || history.stream().mapToInt(m->m.content().length()).sum()>24000) {
            history.removeFirst(); history.removeFirst();
        }
        ChatHistoryStore.Entry saved=new ChatHistoryStore.Entry(historyDestination,List.copyOf(history));
        worker.execute(()->{try{store.save(saved);}catch(RuntimeException failure){emit("aiHistoryStatus",null,"message","Conversation is available in this editor, but could not be saved locally.");}});
        current=null; emit("aiDone",turn.id,null,null);
    }
    private synchronized void fail(Turn turn,String safeMessage) {
        if(!active(turn)) return;
        current=null; if(turn.call!=null) turn.call.cancel();
        emit("aiError",turn.id,"message",safeMessage);
    }
    public synchronized void stop() {
        Turn turn=current;
        if(turn!=null) fail(turn,turn.sent ? "Stopped. The provider may already have received the request." : "Cancelled before sending. No AI request was made.");
    }
    public synchronized void configure() {
        if(closed || configuring || current!=null) return;
        approvedScope=null;
        configuring=true;
        try {
            host.configure(() -> !isClosed(),status -> {
                synchronized(AiChat.this) {
                    configuring=false;
                    if(!closed) emit("aiConfiguration",null,"message",status);
                }
            });
        } catch(RuntimeException failure) {
            configuring=false;
            emit("aiConfiguration",null,"message","AI configuration could not open. Try again.");
        }
    }
    private synchronized boolean isClosed() { return closed; }
    private void emit(String command,String id,String field,String value) {
        if(closed) return;
        JsonObject event=new JsonObject(); event.addProperty("command",command);
        if(id!=null) event.addProperty("requestId",id);
        if(field!=null) event.addProperty(field,value);
        output.accept(event);
    }
    @Override public synchronized void close() { if(closed) return; reset(); context=null; closed=true; worker.shutdown(); transport.close(); }
}
