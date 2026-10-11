package com.heaplens.ai;

import com.google.gson.*;
import com.heaplens.session.*;
import com.heaplens.source.SourceTarget;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class AiAssistanceTest {
    record Approval(AiSourcePort.Source source,AiConfiguration.Settings settings,BooleanSupplier active,Consumer<AiSourcePort.Decision> result) { }
    static final class Source implements AiSourcePort {
        final BlockingQueue<Approval> approvals=new LinkedBlockingQueue<>();
        int reads,reviews,diffs,selections;
        boolean available=true;
        String original,proposed;
        public void select(SourceTarget target,BooleanSupplier active,Consumer<AiSourcePort.Source> reply){selections++;reply.accept(available?new AiSourcePort.Source(target.fileName(),"opaque-local-handle"):null);}
        public void confirm(AiSourcePort.Source file,AiConfiguration.Settings settings,BooleanSupplier active,Consumer<Decision> reply){approvals.add(new Approval(file,settings,active,reply));}
        public String readApproved(AiSourcePort.Source file){reads++;return "class Example { String secret = \"APPROVED_SOURCE\"; }";}
        public void review(AiSourcePort.Source file){reviews++;}
        public void diff(AiSourcePort.Source file,String original,String proposed,BooleanSupplier active){if(active.getAsBoolean()){diffs++;this.original=original;this.proposed=proposed;}}
        Approval next()throws Exception{Approval result=approvals.poll(3,TimeUnit.SECONDS);assertNotNull(result);return result;}
    }
    static void until(BooleanSupplier condition)throws Exception{long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);while(!condition.getAsBoolean() && System.nanoTime()<end)Thread.sleep(5);assertTrue(condition.getAsBoolean());}
    static JsonObject request(boolean fix){JsonObject r=new JsonObject();r.addProperty("requestId","test-1");r.addProperty("className","example.Example");r.addProperty("objectId",42);r.addProperty("fields","PAGE_SECRET");r.addProperty("source","PAGE_SOURCE");r.addProperty("path","PRIVATE_PATH");return r;}
    static AiAssistance assistance(AiChatTest.Host host,Source source,AiChatTest.Transport transport,BooleanSupplier ready,List<JsonObject> events) {
        AnalysisReadPort analysis=(method,params,reply)->{
            String json=switch(method){
                case "inspect_object"->"[{\"name\":\"buffer\",\"field_type\":\"int\",\"primitive_value\":\"RAW_SECRET\",\"ref_summary\":{\"class_name\":\"example.Payload\",\"retained_size\":12,\"preview\":\"RAW_SECRET\"}}]";
                case "gc_root_path"->"[{\"class_name\":\"example.Root\",\"field_name\":\"owner\",\"value\":\"RAW_SECRET\"}]";
                default->"{\"columns\":[\"class_name\",\"shallow_size\",\"retained_size\"],\"rows\":[[\"example.Example\",16,32]]}";
            };
            reply.accept(JsonParser.parseString(json),null);
        };
        AiAssistance assistance=new AiAssistance(host,source,analysis,transport,ready,events::add);
        assistance.analysis(JsonParser.parseString("{\"summary\":{\"total_heap_size\":1024},\"path\":\"PRIVATE_PATH\"}").getAsJsonObject());return assistance;
    }
    @Test void directFixSelectsSourceAndRequiresConsentWithoutReviewingOrOpeningIt()throws Exception {
        var host=new AiChatTest.Host();var source=new Source();var transport=new AiChatTest.Transport();
        try(var service=assistance(host,source,transport,()->true,new CopyOnWriteArrayList<>())){
            service.fix(request(true));Approval approval=source.next();
            assertEquals(1,source.selections);assertEquals(0,source.reviews);assertEquals(0,source.reads);
            assertTrue(transport.sent.isEmpty());approval.result().accept(AiSourcePort.Decision.SEND);
            until(()->!transport.sent.isEmpty());assertEquals(1,source.reads);assertEquals(0,source.reviews);
            transport.sent.getFirst().listener.chunk("class Example { }");transport.sent.getFirst().listener.done();
            service.fix(request(true));source.next();assertEquals(2,source.selections);
            assertEquals(1,transport.sent.size(),"A second Fix needs new source approval, not a cached viewing capability");
        }
    }
    @Test void ineligibleSourceStopsBeforeConsentReadingOrTransmission(){
        var host=new AiChatTest.Host();var source=new Source();source.available=false;
        var transport=new AiChatTest.Transport();List<JsonObject> events=new CopyOnWriteArrayList<>();
        try(var service=assistance(host,source,transport,()->true,events)){
            service.fix(request(true));assertEquals(1,source.selections);assertTrue(source.approvals.isEmpty());
            assertEquals(0,source.reads);assertEquals(0,source.reviews);assertTrue(transport.sent.isEmpty());
            assertEquals("error",events.getLast().get("level").getAsString());
            assertTrue(events.getLast().get("message").getAsString().contains("No writable project Java source"));
        }
    }
    @Test void unavailableConfigurationIsAnExplicitErrorForFixAndExplainWithoutSending()throws Exception {
        for(boolean fix:List.of(false,true)){
            var host=new AiChatTest.Host();host.unavailable=true;
            var source=new Source();var transport=new AiChatTest.Transport();List<JsonObject> events=new CopyOnWriteArrayList<>();
            try(var service=assistance(host,source,transport,()->true,events)){
                if(fix)service.fix(request(true));else service.explain(request(false));
                until(()->!events.isEmpty());var event=events.getLast();
                assertEquals(fix?"fixAiResult":"explainError",event.get("command").getAsString());
                assertEquals("error",event.get("level").getAsString());
                assertEquals("AI configuration is unavailable. Use Configure AI.",event.get("message").getAsString());
                assertEquals(0,source.reads);assertTrue(transport.sent.isEmpty());
            }
        }
    }
    @Test void reviewCancelAndStopAreInformationalNotConfigurationErrors()throws Exception {
        for(AiSourcePort.Decision decision:List.of(AiSourcePort.Decision.CANCEL,AiSourcePort.Decision.REVIEW)){
            var host=new AiChatTest.Host();var source=new Source();var transport=new AiChatTest.Transport();List<JsonObject> events=new CopyOnWriteArrayList<>();
            try(var service=assistance(host,source,transport,()->true,events)){
                service.fix(request(true));source.next().result().accept(decision);
                assertEquals("info",events.getLast().get("level").getAsString());
                service.fix(request(true));source.next();service.stop();
                assertEquals("info",events.getLast().get("level").getAsString());
                assertEquals(0,source.reads);assertTrue(transport.sent.isEmpty());
            }
        }
    }
    @Test void leakExplanationUsesHostSuspectAndNeedsFreshConsent()throws Exception {
        var host=new AiChatTest.Host();var source=new Source();var transport=new AiChatTest.Transport();List<JsonObject> events=new CopyOnWriteArrayList<>();
        try(var service=assistance(host,source,transport,()->true,events)){
            service.analysis(JsonParser.parseString("{\"objectLeakSuspects\":[{\"class_name\":\"example.Example\",\"object_id\":42,\"retained_size\":256,\"retained_percentage\":25}],\"leakSuspects\":[]}").getAsJsonObject());
            service.explainLeak(request(false));host.next().reply().accept(false);assertTrue(transport.sent.isEmpty());
            assertEquals("explainLeakError",events.getLast().get("command").getAsString());
            service.explainLeak(request(false));host.next().reply().accept(true);until(()->!transport.sent.isEmpty());
            var sent=transport.sent.getFirst();String body=sent.messages.toString();assertTrue(body.contains("256"));assertFalse(body.contains("PAGE_SECRET"));assertFalse(body.contains("PAGE_SOURCE"));
            sent.listener.chunk("Investigate");sent.listener.done();assertEquals("explainLeakDone",events.getLast().get("command").getAsString());assertEquals(0,source.reads);
        }
    }
    @Test void cancelAndReviewNeverReadOrSendSourceForAnyProvider()throws Exception {
        for(AiProviders.Provider provider:AiProviders.all())for(AiSourcePort.Decision decision:List.of(AiSourcePort.Decision.CANCEL,AiSourcePort.Decision.REVIEW)) {
            var host=new AiChatTest.Host();host.config=new AiConfiguration(new AiConfiguration.Settings(provider.id(),"https://example.com","model"),"key");
            var source=new Source();var transport=new AiChatTest.Transport();
            try(var service=assistance(host,source,transport,()->true,new ArrayList<>())){
                service.fix(request(true));Approval approval=source.next();approval.result.accept(decision);
                assertEquals(0,source.reads);assertTrue(transport.sent.isEmpty());assertEquals(decision==AiSourcePort.Decision.REVIEW?1:0,source.reviews);
            }
        }
    }
    @Test void chatSessionApprovalNeverAuthorizesExplainOrSourceSubmission()throws Exception {
        var host=new AiChatTest.Host();var source=new Source();var chatTransport=new AiChatTest.Transport();var actionTransport=new AiChatTest.Transport();
        try(var chat=AiChatTest.chat(host,chatTransport,e->{});var service=assistance(host,source,actionTransport,()->true,new CopyOnWriteArrayList<>())) {
            chat.send(AiChatTest.request("chat"));var chatApproval=host.next();assertTrue(chatApproval.session());chatApproval.reply().accept(true);
            chatTransport.sent.getFirst().listener.chunk("answer");chatTransport.sent.getFirst().listener.done();
            for(int i=0;i<2;i++) {
                service.explain(request(false));var explain=host.next();assertFalse(explain.session());explain.reply().accept(false);
                service.fix(request(true));source.next().result().accept(AiSourcePort.Decision.CANCEL);
                assertTrue(actionTransport.sent.isEmpty());assertEquals(0,source.reads);
            }
            chat.send(AiChatTest.request("followup"));until(()->chatTransport.sent.size()==2);assertTrue(host.approvals.isEmpty());
        }
    }
    @Test void approvalPinsDestinationReadsOnlyResolvedSourceAndShowsDiffWithoutWriting()throws Exception {
        var host=new AiChatTest.Host();var source=new Source();var transport=new AiChatTest.Transport();List<JsonObject> events=new CopyOnWriteArrayList<>();
        try(var service=assistance(host,source,transport,()->true,events)){
            service.fix(request(true));Approval approval=source.next();
            host.config=new AiConfiguration(new AiConfiguration.Settings("openai","https://changed.example.com","model"),"other-key");
            approval.result.accept(AiSourcePort.Decision.SEND);approval.result.accept(AiSourcePort.Decision.SEND);until(()->!transport.sent.isEmpty());
            assertEquals(1,source.reads);var sent=transport.sent.getFirst();assertEquals("https://example.com",sent.config.settings().baseUrl());
            String body=sent.messages.toString();assertTrue(body.contains("APPROVED_SOURCE"));
            for(String secret:List.of("PAGE_SECRET","PAGE_SOURCE","PRIVATE_PATH","opaque-local-handle"))assertFalse(body.contains(secret),secret);
            sent.listener.chunk("class Example { }");sent.listener.done();assertEquals(1,source.diffs);assertTrue(source.original.contains("APPROVED_SOURCE"));assertEquals("class Example { }",source.proposed);
            assertEquals("fixAiResult",events.getLast().get("command").getAsString());
        }
    }
    @Test void explainUsesHostMetadataNotPageFieldsOrPrimitiveContents()throws Exception {
        var host=new AiChatTest.Host();var source=new Source();var transport=new AiChatTest.Transport();List<JsonObject> events=new CopyOnWriteArrayList<>();
        try(var service=assistance(host,source,transport,()->true,events)){
            service.explain(request(false));host.next().reply().accept(true);until(()->!transport.sent.isEmpty());
            var sent=transport.sent.getFirst();String body=sent.messages.toString();
            assertTrue(body.contains("example.Payload"));assertTrue(body.contains("owner"));assertTrue(body.contains("buffer"));
            for(String secret:List.of("RAW_SECRET","PAGE_SECRET","PRIVATE_PATH","APPROVED_SOURCE"))assertFalse(body.contains(secret),secret);
            assertEquals(0,source.reads);sent.listener.chunk("Explanation");sent.listener.done();
            assertEquals(List.of("explainChunk","explainDone"),events.stream().map(e->e.get("command").getAsString()).toList());
        }
    }
    @Test void retryAndDisposalRetireConsentAndLateResponses()throws Exception {
        for(boolean approved:List.of(false,true)){
            var host=new AiChatTest.Host();var source=new Source();var transport=new AiChatTest.Transport();List<JsonObject> events=new CopyOnWriteArrayList<>();
            try(var service=assistance(host,source,transport,()->true,events)){
                service.fix(request(true));Approval approval=source.next();
                if(approved){approval.result.accept(AiSourcePort.Decision.SEND);until(()->!transport.sent.isEmpty());}
                service.invalidate();int count=events.size();assertFalse(approval.active.getAsBoolean());
                if(approved){var sent=transport.sent.getFirst();sent.listener.chunk("late");sent.listener.done();assertTrue(sent.cancelled);}
                else approval.result.accept(AiSourcePort.Decision.SEND);
                assertEquals(count,events.size());assertEquals(0,source.diffs);if(!approved)assertEquals(0,source.reads);
            }
        }
    }

    @Test void stopInvalidatesApprovalAndRejectsLateChunksWhileBusyRequestsStaySeparate()throws Exception {
        var host=new AiChatTest.Host();var source=new Source();var transport=new AiChatTest.Transport();List<JsonObject> events=new CopyOnWriteArrayList<>();
        try(var service=assistance(host,source,transport,()->true,events)){
            service.fix(request(true));Approval pending=source.next();
            JsonObject busy=request(true);busy.addProperty("requestId","busy");service.fix(busy);
            assertEquals("busy",events.getLast().get("requestId").getAsString());assertTrue(source.approvals.isEmpty());
            service.stop();pending.result.accept(AiSourcePort.Decision.SEND);assertEquals(0,source.reads);assertTrue(transport.sent.isEmpty());
            service.explain(request(false));host.next().reply().accept(true);until(()->!transport.sent.isEmpty());
            var sent=transport.sent.getFirst();service.stop();int count=events.size();sent.listener.chunk("late");sent.listener.done();
            assertEquals(count,events.size());assertTrue(sent.cancelled);assertEquals(0,source.diffs);
        }
    }
}
