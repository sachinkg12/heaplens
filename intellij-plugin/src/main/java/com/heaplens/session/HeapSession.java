package com.heaplens.session;

import com.google.gson.*;
import com.heaplens.protocol.RpcClient;
import com.heaplens.protocol.RpcResponseException;
import com.heaplens.telemetry.DiagnosticSink;
import java.util.Map;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.*;
import java.util.function.Consumer;
import java.util.function.BiConsumer;

/** One editor's state machine. Transport, UI, and IDE operations are separate ports. */
public final class HeapSession implements AutoCloseable {
    public enum State { NEW, ANALYZING, CANCELLING, READY, CANCELLED, FAILED, CLOSED }
    private final RpcClient.Factory factory;
    private final String path;
    private final Consumer<JsonObject> output;
    private final DiagnosticSink diagnostics;
    private long startedAt;
    private String phase="server_start";
    private boolean retrying;
    private final ExecutorService serial = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "heaplens-session"); t.setDaemon(true); return t;
    });
    private volatile State state = State.NEW;
    private volatile long pid = -1;
    private RpcClient client;
    private long generation, nextId, analysisId;
    private boolean queryPending;
    private int readsPending;

    public HeapSession(RpcClient.Factory factory, Path path, Consumer<JsonObject> output) {
        this(factory,path,output,DiagnosticSink.NONE);
    }
    public HeapSession(RpcClient.Factory factory, Path path, Consumer<JsonObject> output, DiagnosticSink diagnostics) {
        this.factory = factory; this.path = path.toString(); this.output = output;this.diagnostics=diagnostics;
    }
    private void track(String name,Map<String,String> properties,Map<String,Double> metrics) {
        try {diagnostics.track(name,properties,metrics);}catch(RuntimeException ignored){/* Optional observer cannot break analysis. */}
    }
    public void viewed(String tab){track("feature/tabViewed",Map.of("tab",tab),Map.of());}
    private double elapsed(){return Math.min(86400000,(System.nanoTime()-startedAt)/1000000.0);}
    public State state() { return state; }
    public long pid() { return pid; }
    private void dispatch(Runnable task) {
        try { serial.execute(() -> {
            if (state == State.CLOSED) return;
            try { task.run(); }
            catch (RuntimeException invalid) { fail("Invalid server event. Retry is available."); }
        }); }
        catch (RejectedExecutionException ignored) { /* Retired editor. */ }
    }
    public void start() { dispatch(() -> { if (state == State.NEW) begin(); }); }
    public void retry() { dispatch(() -> {
        if (state == State.FAILED || state == State.CANCELLED) {retrying=true;track("analysis/retry",Map.of(),Map.of());begin();}
    }); }
    private void begin() {
        long current = ++generation;
        if (client != null) client.close();
        client = null; queryPending = false; readsPending = 0; state = State.ANALYZING;
        startedAt=System.nanoTime();phase="server_start";track("analysis/started",Map.of(),Map.of());
        JsonObject progress = WebviewEvents.event("analysisProgress");
        progress.addProperty("stage", "loading"); progress.addProperty("phase", 1); progress.addProperty("totalPhases", 4);
        output.accept(progress);
        try {
            client = factory.create(); pid = client.pid();
            client.start(new RpcClient.Listener() {
                @Override public void notification(String method, JsonObject params) {
                    dispatch(() -> { if (current == generation) onNotification(method, params); });
                }
                @Override public void failed(String reason) { dispatch(() -> { if (current == generation) {
                    track("error/serverCrashed",Map.of("errorType","unknown","phase",phase),Map.of());fail(reason);
                } }); }
            });
            analysisId = ++nextId;
            client.request(analysisId, "analyze_heap", params(), Duration.ofSeconds(30)).whenComplete((ack, error) -> dispatch(() -> {
                if (current != generation || (state != State.ANALYZING && state != State.CANCELLING)) return;
                if (error != null || ack == null || !ack.has("request_id") || ack.get("request_id").getAsLong() != analysisId)
                    fail("Analysis did not acknowledge this request. Retry is available.");
                // No deadline for the actual analysis and no destructive heartbeat watchdog.
            }));
        } catch (Exception e) { fail("Could not start the analysis server. Reinstall the matching platform package or select a trusted executable, then Retry.","server_spawn"); }
    }
    private JsonObject params() { JsonObject p = new JsonObject(); p.addProperty("path", path); return p; }
    private void onNotification(String method, JsonObject p) {
        if (p == null || !p.has("request_id") || p.get("request_id").getAsLong() != analysisId) return;
        if (state != State.ANALYZING && state != State.CANCELLING) return;
        if ("heap_analysis_progress".equals(method)) {
            // Cancellation progress is an acknowledgement, NOT worker termination.
            if (p.has("stage") && "cancelled".equals(p.get("stage").getAsString())) return;
            String stage=p.has("stage")?p.get("stage").getAsString():"unknown";
            String next=java.util.Set.of("loading","graph_building","graph_built","dominators").contains(stage)?stage:"unknown";
            if(!next.equals(phase)){phase=next;track("analysis/phase",Map.of("phase",phase),Map.of());}
            output.accept(WebviewEvents.progress(p));
        } else if ("heap_analysis_complete".equals(method)) {
            String status = p.has("status") ? p.get("status").getAsString() : "error";
            if ("completed".equals(status)) {
                state = State.READY;track("analysis/completed",Map.of(),com.heaplens.telemetry.TelemetryMetrics.completion(p,elapsed()));
                if(retrying){track("analysis/recovered",Map.of(),Map.of());retrying=false;}
                output.accept(WebviewEvents.analysis(p));
            }
            else if ("cancelled".equals(status) || "canceled".equals(status)) {
                state = State.CANCELLED;track("analysis/cancelled",Map.of(),Map.of());output.accept(WebviewEvents.event("analysisCancelled"));
            } else fail("Analysis failed. Retry is available.");
        }
    }
    public void cancel() { dispatch(() -> {
        if (state != State.ANALYZING) return;
        state = State.CANCELLING;
        JsonObject p = params(); p.addProperty("analysis_request_id", analysisId);
        long current = generation;
        client.request(++nextId, "cancel_analysis", p, Duration.ofSeconds(5)).whenComplete((v, error) -> dispatch(() -> {
            if (current == generation && state == State.CANCELLING && error != null)
                fail("Cancellation could not be confirmed. Retry will start a fresh server.");
        }));
    }); }
    public void query(String query, int page) { query(query, page, output); }
    public void query(String query, int page, Consumer<JsonObject> reply) { dispatch(() -> {
        if (state != State.READY || queryPending) { queryError("Wait for analysis and the previous query to finish.", query, reply); return; }
        queryPending = true;
        track("feature/queryExecuted",Map.of(),Map.of());
        JsonObject p = params(); p.addProperty("query", query); p.addProperty("page", Math.max(1, page)); p.addProperty("page_size", 500);
        long current = generation;
        client.request(++nextId, "execute_query", p, Duration.ofSeconds(30)).whenComplete((result, error) -> dispatch(() -> {
            if (current != generation || state != State.READY) return;
            queryPending = false;
            if (error != null) {
                track("query/failed",Map.of("errorType",error instanceof TimeoutException?"timeout":"unknown","phase","query"),Map.of());
                queryError(RpcResponseException.display(error,"Query failed or timed out. Check its syntax or retry the query."), query, reply);
            }
            else { JsonObject message = WebviewEvents.event("queryResult"); message.add("result", result); message.addProperty("query", query); reply.accept(message); }
        }));
    }); }
    private void queryError(String reason, String query, Consumer<JsonObject> reply) {
        JsonObject error = WebviewEvents.event("queryError"); error.addProperty("error", reason); error.addProperty("query", query); reply.accept(error);
    }
    /** Bounded, caller-scoped reads. No webview input can choose an RPC method or dump path. */
    public void read(String method, JsonObject parameters, BiConsumer<JsonElement, String> reply) {
        JsonObject request = parameters.deepCopy();
        dispatch(() -> {
            if (state != State.READY || readsPending >= 8) {
                reply.accept(null, "Wait for analysis or other requests to finish, then retry.");
                return;
            }
            request.addProperty("path", path);
            long current = generation;
            readsPending++;
            try {
                client.requestValue(++nextId, method, request, Duration.ofSeconds(30))
                    .whenComplete((result, error) -> dispatch(() -> {
                        if (current != generation || state != State.READY) return;
                        readsPending--;
                        reply.accept(result, error == null ? null : "Analysis request failed or timed out. Try again.");
                    }));
            } catch (RuntimeException failure) {
                readsPending--;
                reply.accept(null, "Analysis request failed. Try again.");
            }
        });
    }
    private void fail(String reason) {
        fail(reason,"unknown");
    }
    private void fail(String reason,String code) {
        if (state == State.FAILED || state == State.CLOSED) return;
        track("analysis/failed",Map.of("errorType",code,"phase",phase),Map.of("durationMs",elapsed()));
        ++generation; state = State.FAILED; queryPending = false; readsPending = 0;
        if (client != null) client.close();
        output.accept(WebviewEvents.error(reason));
    }
    @Override public void close() {
        dispatch(() -> { ++generation; state = State.CLOSED; if (client != null) client.close(); serial.shutdown(); });
    }
}
