package com.heaplens.ai;

import com.google.gson.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

/** Synthetic ports only: no credential store, network, installed IDE or live model. */
class AiInvestigationTest {
    static JsonObject json(String text){return JsonParser.parseString(text).getAsJsonObject();}
    static JsonObject request(String id){return json("{\"requestId\":\""+id+"\",\"text\":\"Investigate retention\"}");}
    @Test void responsePresentationIsProviderNeutralButNeverRepairsOrExtractsJson(){
        String answer="{\"action\":\"answer\",\"facts\":[],\"hypotheses\":[],\"next_checks\":[]}";
        for(String text:List.of(answer,"\ufeff "+answer,"```json\n"+answer+"\n```","```\n"+answer+"\n```"," \u00a0```JSON\r\n"+answer+"\r\n``` "))assertEquals(json(answer),AiInvestigation.parseResponse(text));
        for(String text:List.of("","null","[]","true","Here: "+answer,answer+answer,"```javascript\n"+answer+"\n```","```json\n"+answer+"\n``` extra",answer.substring(0,answer.length()-1),"{action:'answer'}","/*comment*/"+answer))assertThrows(RuntimeException.class,()->AiInvestigation.parseResponse(text));
        assertThrows(IllegalArgumentException.class,()->AiInvestigation.parseResponse(" ".repeat(32769)));
    }
    @Test void everyProviderAcceptsNaturalChatAndRejectsInventedEvidenceHandlesWithoutRetry()throws Exception{
        assertEquals(10,AiProviders.all().size());
        for(var provider:AiProviders.all())for(boolean forged:List.of(false,true))try(var h=new Harness()){
            h.host.config=new AiConfiguration(new AiConfiguration.Settings(provider.id(),"https://example.test","test-model"),"SYNTHETIC_KEY");
            JsonObject page=request(provider.id());page.addProperty("objectId","42");h.ai.explain(page);h.host.approve(true);var sent=h.transport.next();
            String message=sent.messages.stream().filter(m->m.content().startsWith("Actual engine evidence")).findFirst().orElseThrow().content();
            String id=json(message.substring(message.indexOf(": ")+2)).get("id").getAsString();
            String value="{\"action\":\"answer\",\"facts\":[{\"evidence_id\":\""+id+"\",\"field\":\"selected.retained_size\""+(forged?",\"value\":999":"")+"}],\"hypotheses\":[],\"next_checks\":[]}";
            sent.listener.chunk(forged?"Invented evidence [E000000000000_1]":"The selected object retains 88 bytes ["+id+"]. Its lifecycle needs inspection before calling it a leak.");sent.listener.done();AiAssistanceTest.until(()->!h.ai.busy());
            assertEquals(1,h.transport.count.get());assertEquals(1,h.engine.actions.size());
            assertEquals(!forged,h.events.stream().anyMatch(e->e.has("safeEvidenceAnswer")&&e.get("safeEvidenceAnswer").getAsBoolean()),provider.id());
            assertFalse(h.events.toString().contains(": 999 ["));
        }
    }
    static final class Host implements AiHostPort {
        volatile AiConfiguration config=new AiConfiguration(new AiConfiguration.Settings("openai","https://example.test","model"),"FAKE_KEY");
        final BlockingQueue<Consumer<Boolean>> approvals=new LinkedBlockingQueue<>();volatile Runnable changed=()->{};
        volatile CountDownLatch loading,release;
        public AiConfiguration loadConfiguration(){if(loading!=null){loading.countDown();boolean done=false;while(!done)try{release.await();done=true;}catch(InterruptedException ignored){}}return config;}
        public void confirm(AiConfiguration.Settings s,boolean h,BooleanSupplier active,Consumer<Boolean> reply){fail("Legacy consent cannot authorize investigation");}
        public void confirmInvestigation(AiConfiguration.Settings s,BooleanSupplier active,Consumer<Boolean> reply){assertTrue(active.getAsBoolean());approvals.add(reply);}
        public void configure(BooleanSupplier active,Consumer<String> reply){reply.accept("Configured");}
        public AutoCloseable onConfigurationChange(Runnable action){changed=action;return ()->changed=()->{};}
        void approve(boolean decision)throws Exception{Consumer<Boolean> next=approvals.poll(3,TimeUnit.SECONDS);assertNotNull(next);next.accept(decision);}
    }
    static final class Engine implements InvestigationEngine {
        volatile boolean current=true;final List<String> cancelled=new CopyOnWriteArrayList<>();final List<JsonObject> actions=new CopyOnWriteArrayList<>();
        volatile CompletableFuture<JsonObject> pending;
        public String identity(){return "engine-generation";}public boolean current(){return current;}
        public CompletableFuture<JsonObject> read(JsonObject action,String job){actions.add(action);if(pending!=null)return pending;return CompletableFuture.completedFuture(json("{\"schema_version\":1,\"operation\":\""+action.get("operation").getAsString()+"\",\"selected\":{\"object_id\":\""+action.get("object_id").getAsString()+"\",\"class_name\":\"ActualOwner\",\"node_type\":\"Instance\",\"shallow_size\":\"24\",\"retained_size\":\"88\"},\"rows\":[],\"status\":\"complete\",\"truncated\":false,\"raw_value\":\"SECRET_CANARY\"}"));}
        public void cancel(String job){cancelled.add(job);}
    }
    static final class Transport implements LlmTransport {
        record Sent(List<Message> messages,Listener listener,AtomicBoolean cancelled){}
        final BlockingQueue<Sent> sent=new LinkedBlockingQueue<>();final AtomicInteger count=new AtomicInteger();
        public Call start(AiConfiguration c,List<Message> messages,Listener listener){count.incrementAndGet();var cancelled=new AtomicBoolean();sent.add(new Sent(messages,listener,cancelled));return ()->cancelled.set(true);}
        public void close(){}
        Sent next()throws Exception{var next=sent.poll(3,TimeUnit.SECONDS);assertNotNull(next);return next;}
    }
    static final class Harness implements AutoCloseable {
        final Host host=new Host();final Engine engine=new Engine();final Transport transport=new Transport();final List<JsonObject> events=new CopyOnWriteArrayList<>();
        final AiInvestigation ai=new AiInvestigation(host,transport,()->CompletableFuture.completedFuture(engine),()->true,events::add,ChatHistoryStore.NONE);
        Harness(){ai.analysis(json("{\"summary\":{\"total_heap_size\":88},\"topObjects\":[{\"object_id\":\"42\",\"class_name\":\"Owner\",\"node_type\":\"Instance\",\"shallow_size\":24,\"retained_size\":88}],\"path\":\"SECRET_PATH\"}"));}
        void answer(Transport.Sent sent,String hypothesis)throws Exception{sent.listener.chunk(hypothesis);sent.listener.done();AiAssistanceTest.until(()->!ai.busy());}
        public void close(){ai.close();}
    }
    @Test void consentAndChangedConfigurationCannotAuthorizeAnyModelCall()throws Exception{
        try(var h=new Harness()){h.ai.send(request("declined"));h.host.approve(false);AiAssistanceTest.until(()->!h.ai.busy());assertEquals(0,h.transport.count.get());
            h.ai.send(request("changed"));h.host.config=new AiConfiguration(new AiConfiguration.Settings("openai","https://other.test","other"),"other");h.host.approve(true);AiAssistanceTest.until(()->!h.ai.busy());assertEquals(0,h.transport.count.get());}
    }
    @Test void exactWideStringIdsAndActualEngineEvidenceIgnoreForgedPageValues()throws Exception{
        try(var h=new Harness()){var page=request("wide");page.addProperty("objectId","18446744073709551615");page.addProperty("retainedSize",99999);page.addProperty("primitive_value","SECRET_PAGE");h.ai.explain(page);h.host.approve(true);var sent=h.transport.next();String body=sent.messages.toString();
            assertEquals("18446744073709551615",h.engine.actions.getFirst().get("object_id").getAsString());assertTrue(body.contains("ActualOwner"));assertFalse(body.contains("SECRET_"));assertFalse(body.contains("99999"));h.answer(sent,"Needs investigation");
            assertTrue(h.events.stream().anyMatch(e->e.has("safeEvidenceAnswer")&&e.get("safeEvidenceAnswer").getAsBoolean()));assertFalse(h.engine.cancelled.isEmpty());}
    }
    @Test void unsafePageNumbersCannotBecomeRoundedObjectIdentities(){
        assertEquals("9007199254740993",InvestigationEvidence.pageId(new JsonPrimitive("9007199254740993")));
        assertEquals("9007199254740991",InvestigationEvidence.pageId(new JsonPrimitive(9007199254740991L)));
        assertThrows(IllegalArgumentException.class,()->InvestigationEvidence.pageId(new JsonPrimitive(9007199254740992L)));
        assertThrows(IllegalArgumentException.class,()->InvestigationEvidence.pageId(new JsonPrimitive(true)));
    }
    @Test void stopDuringUninterruptibleCredentialLoadCannotRecreateConsentOrBlockNextTurn()throws Exception{
        try(var h=new Harness()){h.host.loading=new CountDownLatch(1);h.host.release=new CountDownLatch(1);h.ai.send(request("old"));assertTrue(h.host.loading.await(3,TimeUnit.SECONDS));h.ai.stop();h.host.release.countDown();
            h.host.loading=null;h.ai.send(request("new"));h.host.approve(false);AiAssistanceTest.until(()->!h.ai.busy());assertTrue(h.host.approvals.isEmpty());assertEquals(0,h.transport.count.get());}
    }
    @Test void stopSettingsRetryAndCloseFenceModelCallbacksAndExpireEvidence()throws Exception{
        for(String action:List.of("stop","settings","retry","close"))try(var h=new Harness()){h.ai.send(request("old"));h.host.approve(true);var sent=h.transport.next();
            switch(action){case "stop"->h.ai.stop();case "settings"->h.host.changed.run();case "retry"->h.ai.unavailable();default->h.ai.close();}
            AiAssistanceTest.until(sent.cancelled::get);int count=h.events.size();sent.listener.chunk("LATE");sent.listener.done();assertEquals(count,h.events.size());}
    }
    @Test void stopCancelsPendingEngineReadAndConsent()throws Exception{
        try(var h=new Harness()){h.ai.send(request("consent"));Consumer<Boolean> pending=h.host.approvals.poll(3,TimeUnit.SECONDS);assertNotNull(pending);h.ai.stop();pending.accept(true);assertEquals(0,h.transport.count.get());
            h.engine.pending=new CompletableFuture<>();var page=request("read");page.addProperty("objectId","42");h.ai.explain(page);h.host.approve(true);AiAssistanceTest.until(()->!h.engine.actions.isEmpty());h.ai.stop();assertFalse(h.engine.cancelled.isEmpty());assertEquals(0,h.transport.count.get());}
    }
    @Test void answerFactsUseLedgerValuesAndRejectFabricatedHandlesOrValues(){
        var ledger=new InvestigationEvidence("scope");JsonObject record=ledger.add("summary",InvestigationEvidence.seed(json("{\"summary\":{\"total_heap_size\":88}}"),null));String id=record.get("id").getAsString();
        JsonObject answer=json("{\"action\":\"answer\",\"facts\":[{\"evidence_id\":\""+id+"\",\"field\":\"summary.total_heap_size\"}],\"hypotheses\":[],\"next_checks\":[]}");assertTrue(ledger.answer(answer,new HashSet<>()).contains(": 88 ["));
        answer.getAsJsonArray("facts").get(0).getAsJsonObject().addProperty("value",999);assertThrows(IllegalArgumentException.class,()->ledger.answer(answer,new HashSet<>()));
        assertThrows(IllegalArgumentException.class,()->ledger.action(json("{\"action\":\"read\",\"tool\":\"execute_query\",\"object_id\":\"42\"}")));
        assertThrows(IllegalArgumentException.class,()->ledger.get("invented"));
    }
    @Test void repeatedReadFailsClosedAndCompletedHistoryIsDestinationScoped()throws Exception{
        try(var h=new Harness()){h.ai.send(request("first"));h.host.approve(true);var first=h.transport.next();h.answer(first,"FIRST_ANSWER");h.ai.send(request("follow"));var follow=h.transport.next();assertTrue(follow.messages.toString().contains("FIRST_ANSWER"));
            readReply(follow,"object");var second=h.transport.next();readReply(second,"object");AiAssistanceTest.until(()->!h.ai.busy());assertEquals(1,h.engine.actions.size());
            h.host.changed.run();h.ai.send(request("new-destination"));h.host.approve(true);var last=h.transport.next();assertFalse(last.messages.toString().contains("FIRST_ANSWER"));h.answer(last,"NEW");}
    }
    @Test void restoredHistoryIsDisplayOnlyAndFailedClearIsVisible()throws Exception{
        Host host=new Host();Engine engine=new Engine();Transport transport=new Transport();List<JsonObject> events=new CopyOnWriteArrayList<>();
        ChatHistoryStore store=new ChatHistoryStore(){public Entry load(){return new Entry("old",List.of(new LlmTransport.Message("user","PRIVATE_OLD_HISTORY")));}public void save(Entry entry){}public void clear(){throw new IllegalStateException("SECRET_IO_ERROR");}};
        try(var ai=new AiInvestigation(host,transport,()->CompletableFuture.completedFuture(engine),()->true,events::add,store)){ai.analysis(json("{\"summary\":{\"total_heap_size\":88}}"));AiAssistanceTest.until(()->events.stream().anyMatch(e->e.get("command").getAsString().equals("aiHistory")));ai.send(request("new"));host.approve(true);var sent=transport.next();assertFalse(sent.messages.toString().contains("PRIVATE_OLD_HISTORY"));ai.clear();AiAssistanceTest.until(()->events.stream().anyMatch(e->e.get("command").getAsString().equals("aiHistoryStatus")));assertFalse(events.toString().contains("SECRET_IO_ERROR"));}
    }
    @Test void evidenceViewerCannotSurviveEngineReplacementEvenBeforeUiReceivesFailure()throws Exception{
        try(var h=new Harness()){h.ai.send(request("done"));h.host.approve(true);var sent=h.transport.next();String id=summaryId(sent);h.answer(sent,"The heap summary is 88 bytes ["+id+"].");JsonObject done=h.events.stream().filter(e->e.get("command").getAsString().equals("aiDone")).findFirst().orElseThrow();assertEquals(id,done.getAsJsonArray("evidence").get(0).getAsJsonObject().get("id").getAsString());h.engine.current=false;JsonObject page=new JsonObject();page.addProperty("id",id);h.ai.openEvidence(page);assertTrue(h.events.getLast().has("error"));assertFalse(h.events.getLast().has("record"));}
    }
    static String summaryId(Transport.Sent sent){String body=sent.messages.stream().filter(m->m.content().startsWith("Current bounded metadata")).findFirst().orElseThrow().content();return json(body.substring(body.indexOf(": ")+2)).get("id").getAsString();}
    @Test void sharedScopePreservesNaturalChatAndDoesNotAttachUncitedMetadata()throws Exception{
        try(var h=new Harness()){
            String sharedScope=AiProviders.resource("system-prompt.txt");
            String scope=sharedScope.substring(sharedScope.indexOf("Scope and safety rules:"),sharedScope.indexOf("You have access to analyzed heap dump data")).strip();
            for(String question:List.of("hi","who is amitabh bachchan","write a birthday poem","what is garbage collection?","Who retains this HashMap and what is HeapQL? Also tell me about a film actor.","Why?")){
                var page=request("scope-"+h.transport.count.get());page.addProperty("text",question);h.ai.send(page);if(h.transport.count.get()==0)h.host.approve(true);
                var sent=h.transport.next();assertTrue(sent.messages.stream().anyMatch(m->m.role().equals("system")&&m.content().contains(scope)));
                assertTrue(sent.messages.toString().contains("fenced code block tagged heapql"));assertEquals(question,sent.messages.getLast().content());
                // Synthetic reply: request-policy coverage, not live provider compliance.
                h.answer(sent,"I can help with Java memory analysis and HeapQL.");
                JsonObject done=h.events.stream().filter(e->e.get("command").getAsString().equals("aiDone")).reduce((a,b)->b).orElseThrow();
                assertEquals(0,done.getAsJsonArray("evidence").size());
            }
            assertEquals(6,h.transport.count.get());assertTrue(h.engine.actions.isEmpty());
        }
    }
    @Test void onlyCitedCurrentAndPreviousEvidenceIsAttachedWithoutDuplicates()throws Exception{
        try(var h=new Harness()){
            h.ai.send(request("first"));h.host.approve(true);var first=h.transport.next();String prior=summaryId(first);h.answer(first,"The summary records 88 bytes ["+prior+"].");
            h.ai.send(request("follow-up"));var second=h.transport.next();String current=summaryId(second);
            h.answer(second,"The earlier summary ["+prior+"] and current summary ["+current+"] record 88 bytes ["+prior+"].");
            JsonArray links=h.events.stream().filter(e->e.get("command").getAsString().equals("aiDone")).reduce((a,b)->b).orElseThrow().getAsJsonArray("evidence");
            assertEquals(2,links.size());assertEquals(prior,links.get(0).getAsJsonObject().get("id").getAsString());assertEquals(current,links.get(1).getAsJsonObject().get("id").getAsString());
            h.ai.send(request("uncited-after-read"));readReply(h.transport.next(),"object");h.answer(h.transport.next(),"Inspect the intended owner lifecycle.");
            assertEquals(1,h.engine.actions.size());JsonObject done=h.events.stream().filter(e->e.get("command").getAsString().equals("aiDone")).reduce((a,b)->b).orElseThrow();assertEquals(0,done.getAsJsonArray("evidence").size());
        }
    }
    @Test void saturatedWorkerCannotSilentlyLoseDiskHistoryClear()throws Exception{
        try(var h=new Harness()){h.host.loading=new CountDownLatch(1);h.host.release=new CountDownLatch(1);h.ai.send(request("blocked"));assertTrue(h.host.loading.await(3,TimeUnit.SECONDS));h.ai.clear();h.ai.clear();
            assertTrue(h.events.stream().anyMatch(e->e.get("command").getAsString().equals("aiHistoryStatus")&&e.get("message").getAsString().contains("Retry Clear")));h.host.release.countDown();}
    }
    static void readReply(Transport.Sent sent,String operation){sent.listener.tools(List.of(new LlmTransport.ToolCall("call_"+operation,"heap_read","{\"operation\":\""+operation+"\",\"object_id\":\"42\"}")));sent.listener.done();}
    @Test void overviewAnswersFromTheExistingSummaryWithoutAnyEngineRead()throws Exception{
        try(var h=new Harness()){
            var page=request("overview");page.addProperty("text","tell me about this heapdump");h.ai.send(page);h.host.approve(true);var sent=h.transport.next();
            assertTrue(sent.messages.toString().contains("Prefer answering from the supplied summary"));
            String body=sent.messages.stream().filter(m->m.content().startsWith("Current bounded metadata")).findFirst().orElseThrow().content();
            String id=json(body.substring(body.indexOf(": ")+2)).get("id").getAsString();
            sent.listener.chunk("The heap summary is 88 bytes ["+id+"]. This is not proof of a leak.");sent.listener.done();AiAssistanceTest.until(()->!h.ai.busy());
            assertEquals(1,h.transport.count.get());assertTrue(h.engine.actions.isEmpty());assertTrue(h.events.stream().anyMatch(e->e.has("text")&&e.get("text").getAsString().contains("88 bytes")));
        }
    }
    @Test void everyProviderHasAnAnswerOnlyFinalStepAndAnHonestBoundedSummaryIfItStillRequestsReads()throws Exception{
        for(var provider:AiProviders.all())for(boolean obey:List.of(true,false))try(var h=new Harness()){
            h.host.config=new AiConfiguration(new AiConfiguration.Settings(provider.id(),"https://example.test","test-model"),"SYNTHETIC_KEY");
            h.ai.send(request("budget"));h.host.approve(true);
            for(String op:List.of("object","outbound","referrers"))readReply(h.transport.next(),op);
            var last=h.transport.next();assertTrue(last.messages.stream().anyMatch(m->m.role().equals("system")&&m.content().contains("FINAL ANSWER ONLY")),provider.id());
            if(obey)h.answer(last,"Existing evidence needs application context");else{readReply(last,"root_path");AiAssistanceTest.until(()->!h.ai.busy());}
            assertEquals(4,h.transport.count.get(),provider.id());assertEquals(3,h.engine.actions.size(),provider.id());
            JsonObject done=h.events.stream().filter(e->e.get("command").getAsString().equals("aiDone")).findFirst().orElseThrow();
            assertEquals(!obey,done.get("metadataOnly").getAsBoolean());assertEquals(4,done.get("modelCalls").getAsInt());assertEquals(3,done.get("reads").getAsInt());
            if(!obey){
                assertTrue(h.events.stream().anyMatch(e->e.has("text")&&e.get("text").getAsString().contains("Metadata summary only")&&e.get("text").getAsString().contains(": 88 [")));
                h.ai.send(request("follow-up"));var next=h.transport.next();assertFalse(next.messages.toString().contains("Metadata summary only"));h.answer(next,"New completed answer");
            }
            assertFalse(h.events.toString().contains("SECRET_"));
        }
    }
    @Test void exhaustedBudgetStillRejectsUnknownIdentitiesAndForbiddenTools()throws Exception{
        for(String bad:List.of("{\"action\":\"read\",\"tool\":\"object\",\"object_id\":\"999\"}","{\"action\":\"read\",\"tool\":\"execute_query\",\"object_id\":\"42\"}"))try(var h=new Harness()){
            h.ai.send(request("bad-final"));h.host.approve(true);for(String op:List.of("object","outbound","referrers"))readReply(h.transport.next(),op);
            var last=h.transport.next();JsonObject old=json(bad);last.listener.tools(List.of(new LlmTransport.ToolCall("bad_call","heap_read","{\"operation\":\""+old.get("tool").getAsString()+"\",\"object_id\":\""+old.get("object_id").getAsString()+"\"}")));last.listener.done();AiAssistanceTest.until(()->!h.ai.busy());
            assertFalse(h.events.stream().anyMatch(e->e.get("command").getAsString().equals("aiDone")));assertEquals(4,h.transport.count.get());assertEquals(3,h.engine.actions.size());
            assertTrue(h.events.stream().anyMatch(e->e.has("message")&&e.get("message").getAsString().contains("failed validation")));
        }
    }
    @Test void providerAndMetadataFailuresAreDistinguishableWithoutLeakingTheirRawMessages()throws Exception{
        try(var h=new Harness()){
            h.ai.send(request("provider"));h.host.approve(true);h.transport.next().listener.error("SECRET_PROVIDER_BODY");AiAssistanceTest.until(()->!h.ai.busy());
            assertTrue(h.events.stream().anyMatch(e->e.has("message")&&e.get("message").getAsString().contains("AI provider request failed")));assertFalse(h.events.toString().contains("SECRET_PROVIDER_BODY"));
        }
        try(var h=new Harness()){
            h.engine.pending=CompletableFuture.failedFuture(new IllegalStateException("SECRET_ENGINE_ERROR"));var page=request("engine");page.addProperty("objectId","42");h.ai.explain(page);h.host.approve(true);AiAssistanceTest.until(()->!h.ai.busy());
            assertEquals(0,h.transport.count.get());assertTrue(h.events.stream().anyMatch(e->e.has("message")&&e.get("message").getAsString().contains("heap metadata request failed")));assertFalse(h.events.toString().contains("SECRET_ENGINE_ERROR"));
        }
    }
    @Test void cancellationAtTheLastStepCannotPublishABudgetSummary()throws Exception{
        try(var h=new Harness()){
            h.ai.send(request("cancel-final"));h.host.approve(true);for(String op:List.of("object","outbound","referrers"))readReply(h.transport.next(),op);
            var last=h.transport.next();h.ai.stop();readReply(last,"root_path");assertFalse(h.events.stream().anyMatch(e->e.get("command").getAsString().equals("aiDone")));assertEquals(3,h.engine.actions.size());
        }
    }
}
