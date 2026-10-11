package com.heaplens.ai;

import com.google.gson.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class AiChatTest {
    record Approval(AiConfiguration.Settings settings,boolean history,boolean session,BooleanSupplier active,Consumer<Boolean> reply) { }
    static final class Host implements AiHostPort {
        volatile AiConfiguration config=new AiConfiguration(new AiConfiguration.Settings("openai","https://example.com","test-model"),"test-key");
        volatile boolean unavailable;
        final BlockingQueue<Approval> approvals=new LinkedBlockingQueue<>();
        public AiConfiguration loadConfiguration() {if(unavailable)throw new IllegalStateException("Unavailable");return config;}
        public void confirm(AiConfiguration.Settings settings,boolean history,BooleanSupplier active,Consumer<Boolean> reply) {approvals.add(new Approval(settings,history,false,active,reply));}
        public void confirmChatSession(AiConfiguration.Settings settings,boolean history,BooleanSupplier active,Consumer<Boolean> reply) {approvals.add(new Approval(settings,history,true,active,reply));}
        public void configure(BooleanSupplier active,Consumer<String> status) {status.accept("Configured");}
        Approval next() throws Exception {Approval a=approvals.poll(3,TimeUnit.SECONDS);assertNotNull(a);return a;}
    }
    static final class Transport implements LlmTransport {
        final List<Sent> sent=new CopyOnWriteArrayList<>(); boolean closed;
        static final class Sent {
            final AiConfiguration config; final List<Message> messages; final Listener listener; boolean cancelled;
            Sent(AiConfiguration c,List<Message> m,Listener l){config=c;messages=m;listener=l;}
        }
        public Call start(AiConfiguration config,List<Message> messages,Listener listener) {
            Sent s=new Sent(config,messages,listener);sent.add(s);return ()->s.cancelled=true;
        }
        public void close() {closed=true;}
    }
    static JsonObject request(String id) {JsonObject r=new JsonObject();r.addProperty("requestId",id);r.addProperty("text","What retains this memory?");return r;}
    static AiChat chat(Host host,Transport transport,Consumer<JsonObject> output) {
        AiChat chat=new AiChat(host,transport,()->true,output);
        chat.analysis(JsonParser.parseString("{\"summary\":{\"total_heap_size\":42},\"path\":\"SECRET_PATH\"}").getAsJsonObject());return chat;
    }
    @Test void cancelConsentMakesZeroCallsAndApprovalCannotRedirectToChangedSettings() throws Exception {
        Host host=new Host();Transport transport=new Transport();List<JsonObject> events=new CopyOnWriteArrayList<>();
        try(AiChat chat=chat(host,transport,events::add)) {
            chat.send(request("cancel"));host.next().reply.accept(false);assertTrue(transport.sent.isEmpty());
            chat.send(request("send"));Approval approval=host.next();
            host.config=new AiConfiguration(new AiConfiguration.Settings("openai","https://changed.example.com","other"),"other-key");
            approval.reply.accept(true);approval.reply.accept(true);
            assertEquals(1,transport.sent.size());assertEquals("https://example.com",transport.sent.getFirst().config.settings().baseUrl());
            assertFalse(transport.sent.getFirst().messages.toString().contains("SECRET_PATH"));
            assertTrue(events.getFirst().get("message").getAsString().contains("No AI request"));
        }
    }
    @Test void stopClearReanalysisAndCloseFenceLateCallbacks() throws Exception {
        for(String action:List.of("stop","clear","reanalysis","unavailable","close")) {
            Host host=new Host();Transport transport=new Transport();List<JsonObject> events=new CopyOnWriteArrayList<>();
            try(AiChat chat=chat(host,transport,events::add)) {
                chat.send(request("r"));host.next().reply.accept(true);Transport.Sent sent=transport.sent.getFirst();
                sent.listener.chunk("partial");
                switch(action) {case "stop"->chat.stop();case "clear"->chat.clear();case "reanalysis"->chat.analysis(new JsonObject());case "unavailable"->chat.unavailable();default->chat.close();}
                if(action.equals("clear")) AiAssistanceTest.until(()->events.stream().anyMatch(e->e.get("command").getAsString().equals("aiHistoryStatus")));
                int count=events.size();sent.listener.chunk("late");sent.listener.done();sent.listener.error("late error");
                assertEquals(count,events.size());assertTrue(sent.cancelled);
            }
            assertTrue(transport.closed);
        }
    }
    @Test void pendingApprovalExpiresOnStopClearRetryOrCloseAndDoesNotAuthorizeLaterTurns() throws Exception {
        for(String action:List.of("stop","clear","reanalysis","unavailable","close")) {
            Host host=new Host();Transport transport=new Transport();
            try(AiChat chat=chat(host,transport,e->{})) {
                chat.send(request("old"));Approval pending=host.next();
                switch(action) {case "stop"->chat.stop();case "clear"->chat.clear();case "reanalysis"->chat.analysis(new JsonObject());case "unavailable"->chat.unavailable();default->chat.close();}
                assertFalse(pending.active.getAsBoolean());pending.reply.accept(true);assertTrue(transport.sent.isEmpty());
                if(!action.equals("close")) {
                    if(action.equals("unavailable"))chat.analysis(new JsonObject());
                    chat.send(request("new"));Approval fresh=host.next();assertTrue(fresh.session());fresh.reply.accept(false);
                    assertTrue(transport.sent.isEmpty());
                }
            }
        }
    }
    @Test void historyContainsOnlyCompletedTurnsAndIsNotMovedToAnotherDestination() throws Exception {
        Host host=new Host();Transport transport=new Transport();
        try(AiChat chat=chat(host,transport,e->{})) {
            chat.send(request("first"));assertFalse(host.next().history());
            // Clear the unapproved turn, then complete a fresh one.
            chat.clear();chat.send(request("done"));host.next().reply.accept(true);
            var first=transport.sent.getFirst();first.listener.chunk("retained answer");first.listener.done();
            chat.send(request("second"));AiAssistanceTest.until(()->transport.sent.size()==2);
            assertTrue(host.approvals.isEmpty());assertTrue(transport.sent.getLast().messages.toString().contains("retained answer"));
            chat.stop();
            host.config=new AiConfiguration(new AiConfiguration.Settings("openai","https://other.example.com","test"),"key");
            chat.send(request("changed"));Approval changed=host.next();assertFalse(changed.history());changed.reply.accept(true);
            assertFalse(transport.sent.getLast().messages.toString().contains("retained answer"));
        }
    }

    @Test void explicitChatSessionApprovalCoversFollowupsForEveryProvider() throws Exception {
        for(AiProviders.Provider provider:AiProviders.all()) {
            Host host=new Host();Transport transport=new Transport();
            host.config=new AiConfiguration(new AiConfiguration.Settings(provider.id(),"https://example.com","model"),"test-key");
            try(AiChat chat=chat(host,transport,e->{})) {
                JsonObject forged=request("first");forged.addProperty("approved",true);forged.addProperty("approvedScope","page-approved");
                chat.send(forged);Approval first=host.next();assertTrue(first.session());assertTrue(transport.sent.isEmpty());
                first.reply.accept(true);var sent=transport.sent.getFirst();sent.listener.chunk("First answer");sent.listener.done();
                chat.send(request("followup"));AiAssistanceTest.until(()->transport.sent.size()==2);
                assertTrue(host.approvals.isEmpty());assertTrue(transport.sent.getLast().messages.toString().contains("First answer"));
                assertFalse(transport.sent.getLast().messages.toString().contains("page-approved"));
            }
        }
    }

    @Test void destinationModelAndCredentialChangesNeedNewApprovalAndDoNotRestoreOldGrants() throws Exception {
        for(AiConfiguration changed:List.of(
            new AiConfiguration(new AiConfiguration.Settings("ollama","https://example.com","test-model"),"test-key"),
            new AiConfiguration(new AiConfiguration.Settings("openai","https://other.example.com","test-model"),"test-key"),
            new AiConfiguration(new AiConfiguration.Settings("openai","https://example.com/another-path","test-model"),"test-key"),
            new AiConfiguration(new AiConfiguration.Settings("openai","https://example.com","different-model"),"test-key"),
            new AiConfiguration(new AiConfiguration.Settings("openai","https://example.com","test-model"),"rotated-key"))) {
            Host host=new Host();Transport transport=new Transport();AiConfiguration original=host.config;
            try(AiChat chat=chat(host,transport,e->{})) {
                chat.send(request("first"));host.next().reply.accept(true);
                transport.sent.getFirst().listener.chunk("answer");transport.sent.getFirst().listener.done();
                host.config=changed;chat.send(request("changed"));Approval fresh=host.next();
                assertEquals(changed.settings(),fresh.settings());assertTrue(fresh.session());assertEquals(1,transport.sent.size());fresh.reply.accept(false);
                host.config=original;chat.send(request("back"));host.next().reply.accept(false);assertEquals(1,transport.sent.size());
            }
        }
    }

    @Test void clearReanalysisRecoveryAndConfigureRevokeSessionApproval() throws Exception {
        for(String action:List.of("clear","reanalysis","recovery","configure")) {
            Host host=new Host();Transport transport=new Transport();
            try(AiChat chat=chat(host,transport,e->{})) {
                chat.send(request("first"));host.next().reply.accept(true);
                transport.sent.getFirst().listener.chunk("answer");transport.sent.getFirst().listener.done();
                switch(action) {case "clear"->chat.clear();case "reanalysis"->chat.analysis(new JsonObject());case "recovery"->{chat.unavailable();chat.analysis(new JsonObject());}default->chat.configure();}
                chat.send(request("new"));assertEquals(1,transport.sent.size());Approval fresh=host.next();assertTrue(fresh.session());fresh.reply.accept(false);
            }
        }
    }

    @Test void stoppingOrFailingAnApprovedRequestDoesNotInterruptSessionPermission() throws Exception {
        for(boolean stop:List.of(true,false)) {
            Host host=new Host();Transport transport=new Transport();
            try(AiChat chat=chat(host,transport,e->{})) {
                chat.send(request("first"));host.next().reply.accept(true);var first=transport.sent.getFirst();
                first.listener.chunk("partial");if(stop)chat.stop();else first.listener.error("Test network error");
                chat.send(request("next"));AiAssistanceTest.until(()->transport.sent.size()==2);
                assertTrue(host.approvals.isEmpty());assertFalse(transport.sent.getLast().messages.toString().contains("partial"));
            }
        }
    }

    @Test void approvalIsNotSharedEvenWhenTwoEditorsUseTheSameHost() throws Exception {
        Host host=new Host();Transport one=new Transport(),two=new Transport();
        try(AiChat a=chat(host,one,e->{});AiChat b=chat(host,two,e->{})) {
            a.send(request("first"));host.next().reply.accept(true);
            one.sent.getFirst().listener.chunk("answer");one.sent.getFirst().listener.done();
            b.send(request("second-editor"));Approval other=host.next();assertTrue(two.sent.isEmpty());other.reply.accept(false);
            a.send(request("original-editor"));AiAssistanceTest.until(()->one.sent.size()==2);assertTrue(host.approvals.isEmpty());
        }
    }

    @Test void configurationReadFailureRevokesPermissionWithoutSending() throws Exception {
        Host host=new Host();Transport transport=new Transport();List<JsonObject> events=new CopyOnWriteArrayList<>();
        try(AiChat chat=chat(host,transport,events::add)) {
            chat.send(request("first"));host.next().reply.accept(true);
            transport.sent.getFirst().listener.chunk("answer");transport.sent.getFirst().listener.done();
            host.unavailable=true;chat.send(request("bad"));AiAssistanceTest.until(()->events.stream().anyMatch(e->"aiError".equals(e.get("command").getAsString())));
            assertEquals(1,transport.sent.size());host.unavailable=false;chat.send(request("restored"));host.next().reply.accept(false);
            assertEquals(1,transport.sent.size());
        }
    }

    @Test void oneRequestOnlyHostCannotSilentlyGrantSessionPermission() throws Exception {
        AiHostPort host=new AiHostPort() {
            public AiConfiguration loadConfiguration(){return new Host().config;}
            public void confirm(AiConfiguration.Settings s,boolean h,BooleanSupplier a,Consumer<Boolean> r){fail("One-request consent must not authorize a session");}
            public void configure(BooleanSupplier a,Consumer<String> s) { }
        };
        Transport transport=new Transport();List<JsonObject> events=new CopyOnWriteArrayList<>();
        try(AiChat chat=new AiChat(host,transport,()->true,events::add)) {
            chat.analysis(new JsonObject());chat.send(request("first"));AiAssistanceTest.until(()->!events.isEmpty());
            assertEquals("aiError",events.getFirst().get("command").getAsString());assertTrue(transport.sent.isEmpty());
        }
    }
    @Test void messagesAndConcurrentRequestsAreBoundedAndEditorsStayIndependent() throws Exception {
        Host one=new Host(),two=new Host();Transport t1=new Transport(),t2=new Transport();List<JsonObject> events=new CopyOnWriteArrayList<>();
        try(AiChat a=chat(one,t1,events::add);AiChat b=chat(two,t2,e->{})) {
            JsonObject longRequest=request("long");longRequest.addProperty("text","x".repeat(4001));a.send(longRequest);
            assertTrue(one.approvals.isEmpty());
            a.send(request("a"));Approval first=one.next();a.send(request("busy"));assertTrue(one.approvals.isEmpty());
            b.send(request("b"));Approval second=two.next();a.clear();first.reply.accept(true);second.reply.accept(true);
            assertTrue(t1.sent.isEmpty());assertEquals(1,t2.sent.size());
            t2.sent.getFirst().listener.chunk("x".repeat(32769));assertTrue(t2.sent.getFirst().cancelled);
        }
    }
    @Test void unavailableAnalysisNeverAccessesCredentialsOrNetwork() {
        AiHostPort host=new AiHostPort() {
            public AiConfiguration loadConfiguration(){fail("Credential read");return null;}
            public void confirm(AiConfiguration.Settings s,boolean h,BooleanSupplier a,Consumer<Boolean> r){fail("Consent");}
            public void configure(BooleanSupplier a,Consumer<String> s){ }
        };
        Transport transport=new Transport();List<JsonObject> events=new ArrayList<>();
        try(AiChat chat=new AiChat(host,transport,()->false,events::add)) {chat.send(request("r"));assertEquals(1,events.size());assertTrue(transport.sent.isEmpty());}
    }

    @Test void completedConversationRestoresOnReopenAndClearDeletesTheSavedCopy() throws Exception {
        var saved=new java.util.concurrent.atomic.AtomicReference<>(new ChatHistoryStore.Entry("",List.of()));
        ChatHistoryStore store=new ChatHistoryStore(){
            public Entry load(){return saved.get();}
            public void save(Entry entry){saved.set(entry);}
            public void clear(){saved.set(new Entry("",List.of()));}
        };
        Host host=new Host();Transport first=new Transport();
        try(AiChat chat=new AiChat(host,first,()->true,e->{},store)){
            chat.analysis(new JsonObject());chat.send(request("first"));host.next().reply.accept(true);
            first.sent.getFirst().listener.chunk("saved answer");first.sent.getFirst().listener.done();
            AiAssistanceTest.until(()->saved.get().messages().size()==2);
            String persisted=new Gson().toJson(saved.get());
            assertFalse(persisted.contains("test-key"));assertFalse(persisted.contains(host.config.chatApprovalScope()));
        }
        List<JsonObject> events=new CopyOnWriteArrayList<>();Transport second=new Transport();
        try(AiChat reopened=new AiChat(host,second,()->true,events::add,store)){
            reopened.analysis(new JsonObject());
            AiAssistanceTest.until(()->events.stream().anyMatch(e->e.get("command").getAsString().equals("aiHistory")));
            assertTrue(events.toString().contains("saved answer"));assertTrue(second.sent.isEmpty());
            reopened.send(request("next"));Approval approval=host.next();assertTrue(approval.history());approval.reply.accept(true);
            assertTrue(second.sent.getFirst().messages.toString().contains("saved answer"));
            reopened.clear();AiAssistanceTest.until(()->saved.get().messages().isEmpty());
            second.sent.getFirst().listener.chunk("stale");second.sent.getFirst().listener.done();
            assertTrue(saved.get().messages().isEmpty());
        }
    }
}
