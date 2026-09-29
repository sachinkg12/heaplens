package com.heaplens.session;

import com.google.gson.*;
import com.heaplens.protocol.RpcClient;
import java.nio.file.Path;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;

class HeapSessionTest {
    static class Fake implements RpcClient {
        Listener listener;
        final List<String> methods = new CopyOnWriteArrayList<>();
        final Map<String, JsonObject> params = new ConcurrentHashMap<>();
        volatile boolean closed;
        volatile long analysisId;
        CompletableFuture<JsonObject> ack = new CompletableFuture<>();
        @Override public void start(Listener value) { listener = value; }
        @Override public CompletableFuture<JsonObject> request(long id, String method, JsonObject p, Duration timeout) {
            params.put(method, p); methods.add(method);
            if (method.equals("analyze_heap")) { analysisId = id; return ack; }
            return CompletableFuture.completedFuture(new JsonObject());
        }
        void notify(String method, String status, long id) {
            JsonObject p = new JsonObject(); p.addProperty("request_id", id); p.addProperty("status", status);
            p.addProperty("stage", status); p.add("summary", new JsonObject());
            listener.notification(method, p);
        }
        void complete() { notify("heap_analysis_complete", "completed", analysisId); }
        @Override public boolean isAlive() { return !closed; }
        @Override public long pid() { return 123; }
        @Override public void close() { closed = true; }
    }
    List<Fake> clients = new CopyOnWriteArrayList<>();
    List<JsonObject> events = new CopyOnWriteArrayList<>();
    HeapSession session;
    @BeforeEach void setup() {
        session = new HeapSession(() -> { Fake f = new Fake(); clients.add(f); return f; }, Path.of("dump with spaces.hprof"), events::add);
    }
    @AfterEach void close() { session.close(); await(() -> session.state() == HeapSession.State.CLOSED); }
    static void await(BooleanSupplier condition) {
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        while (!condition.getAsBoolean() && System.nanoTime() < deadline) {
            try { Thread.sleep(5); } catch (InterruptedException e) { throw new AssertionError(e); }
        }
        assertTrue(condition.getAsBoolean(), "Condition did not become true");
    }
    Fake started() { session.start(); await(() -> !clients.isEmpty() && clients.getFirst().analysisId > 0); return clients.getFirst(); }
    boolean hasEvent(String command) { return events.stream().anyMatch(e -> command.equals(e.get("command").getAsString())); }

    @Test void earlyCompletionDoesNotDependOnAckOrderAndStartIsIdempotent() {
        Fake f = started(); session.start(); f.complete();
        await(() -> session.state() == HeapSession.State.READY);
        f.ack.completeExceptionally(new TimeoutException());
        session.query("SELECT * FROM instances LIMIT 1", 1);
        await(() -> hasEvent("queryResult")); assertEquals(1, clients.size());
        assertEquals("dump with spaces.hprof", f.params.get("analyze_heap").get("path").getAsString());
    }
    @Test void cancelWaitsForWorkerTerminalAndCarriesCorrelationId() {
        Fake f = started(); session.cancel();
        await(() -> f.methods.contains("cancel_analysis"));
        assertEquals(f.analysisId, f.params.get("cancel_analysis").get("analysis_request_id").getAsLong());
        f.notify("heap_analysis_progress", "cancelled", f.analysisId);
        session.query("ignored", 1); await(() -> hasEvent("queryError"));
        assertEquals(HeapSession.State.CANCELLING, session.state());
        assertFalse(hasEvent("analysisCancelled"));
        f.notify("heap_analysis_complete", "cancelled", f.analysisId);
        await(() -> session.state() == HeapSession.State.CANCELLED);
        session.retry(); await(() -> clients.size() == 2); assertTrue(f.closed);
    }
    @Test void crashRetryCreatesOneClientAndFencesRetiredNotifications() {
        Fake first = started(); first.complete(); await(() -> session.state() == HeapSession.State.READY);
        first.listener.failed("test crash"); await(() -> session.state() == HeapSession.State.FAILED);
        for (int i = 0; i < 25; i++) session.retry();
        await(() -> clients.size() == 2 && clients.get(1).analysisId > 0);
        first.complete(); first.listener.failed("late crash");
        session.query("ignored", 1); await(() -> hasEvent("queryError"));
        assertEquals(HeapSession.State.ANALYZING, session.state());
        clients.get(1).complete(); await(() -> session.state() == HeapSession.State.READY);
        session.query("SELECT 1", 2); await(() -> clients.get(1).methods.contains("execute_query"));
        assertEquals(2, clients.size()); assertFalse(first.methods.contains("execute_query"));
    }
    @Test void wrongRequestIdCannotCompleteAnalysis() {
        Fake f = started(); f.notify("heap_analysis_complete", "completed", f.analysisId + 1);
        session.query("ignored", 1); await(() -> hasEvent("queryError"));
        assertEquals(HeapSession.State.ANALYZING, session.state());
        f.complete(); await(() -> session.state() == HeapSession.State.READY);
    }
    @Test void acknowledgementFailureHasVisibleRecovery() {
        Fake f = started(); f.ack.complete(new JsonObject());
        await(() -> hasEvent("serverCrashed")); assertTrue(f.closed);
    }
    @Test void malformedNotificationFailsClosedRatherThanLeavingAStuckSession() {
        Fake f = started(); JsonObject bad = new JsonObject(); bad.add("request_id", new JsonArray());
        f.listener.notification("heap_analysis_complete", bad);
        await(() -> hasEvent("serverCrashed"));
    }
    @Test void spawnFailureDoesNotPreventFutureRetry() {
        session.close(); await(() -> session.state() == HeapSession.State.CLOSED);
        session = new HeapSession(() -> { throw new java.io.IOException("secret path"); }, Path.of("dump"), events::add);
        session.start(); await(() -> hasEvent("serverCrashed"));
        assertFalse(events.toString().contains("secret path"));
        session.retry(); await(() -> events.stream().filter(e -> "serverCrashed".equals(e.get("command").getAsString())).count() == 2);
    }
    @Test void disposalClosesOnlyItsOwnClientAndIsIdempotent() {
        Fake first = started(); List<JsonObject> otherEvents = new CopyOnWriteArrayList<>(); Fake other = new Fake();
        try (HeapSession second = new HeapSession(() -> other, Path.of("other"), otherEvents::add)) {
            second.start(); await(() -> other.analysisId > 0);
            session.close(); session.close(); await(() -> first.closed);
            assertFalse(other.closed); first.listener.failed("intentional close");
            assertFalse(hasEvent("serverCrashed")); other.complete();
            await(() -> second.state() == HeapSession.State.READY);
        }
    }
    @Test void generatedEventOrdersIgnoreWrongIdsAndRetiredClients() {
        Random random = new Random(72123); Fake f = started();
        for (int i = 0; i < 200; i++) f.notify("heap_analysis_complete", "completed", 2 + random.nextInt(10000));
        session.query("barrier", 1); await(() -> hasEvent("queryError"));
        assertEquals(HeapSession.State.ANALYZING, session.state());
        f.complete(); await(() -> session.state() == HeapSession.State.READY);
    }
    @Test void routerRejectsUnimplementedCapabilitiesAndMalformedInput() {
        CommandRouter router = CommandRouter.forSession(session, () -> { });
        for (String value : List.of("[]", "null", "{", "{}", "{\"command\":\"aiChat\"}", "{\"command\":\"executeQuery\"}", "x".repeat(128 * 1024 + 1)))
            assertFalse(router.dispatch(value));
        assertTrue(router.dispatch("{\"command\":\"ready\"}")); assertTrue(clients.isEmpty());
    }
}
