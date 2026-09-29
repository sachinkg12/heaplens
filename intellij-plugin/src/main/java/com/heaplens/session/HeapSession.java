package com.heaplens.session;

import com.google.gson.JsonObject;
import com.heaplens.protocol.RpcClient;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.*;
import java.util.function.Consumer;

/** One editor's state machine. Transport, UI, and IDE operations are separate ports. */
public final class HeapSession implements AutoCloseable {
    public enum State { NEW, ANALYZING, CANCELLING, READY, CANCELLED, FAILED, CLOSED }
    private final RpcClient.Factory factory;
    private final String path;
    private final Consumer<JsonObject> output;
    private final ExecutorService serial = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "heaplens-session"); t.setDaemon(true); return t;
    });
    private volatile State state = State.NEW;
    private volatile long pid = -1;
    private RpcClient client;
    private long generation, nextId, analysisId;
    private boolean queryPending;

    public HeapSession(RpcClient.Factory factory, Path path, Consumer<JsonObject> output) {
        this.factory = factory; this.path = path.toString(); this.output = output;
    }
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
        if (state == State.FAILED || state == State.CANCELLED) begin();
    }); }
    private void begin() {
        long current = ++generation;
        if (client != null) client.close();
        client = null; queryPending = false; state = State.ANALYZING;
        JsonObject progress = WebviewEvents.event("analysisProgress");
        progress.addProperty("stage", "loading"); progress.addProperty("phase", 1); progress.addProperty("totalPhases", 4);
        output.accept(progress);
        try {
            client = factory.create(); pid = client.pid();
            client.start(new RpcClient.Listener() {
                @Override public void notification(String method, JsonObject params) {
                    dispatch(() -> { if (current == generation) onNotification(method, params); });
                }
                @Override public void failed(String reason) { dispatch(() -> { if (current == generation) fail(reason); }); }
            });
            analysisId = ++nextId;
            client.request(analysisId, "analyze_heap", params(), Duration.ofSeconds(30)).whenComplete((ack, error) -> dispatch(() -> {
                if (current != generation || (state != State.ANALYZING && state != State.CANCELLING)) return;
                if (error != null || ack == null || !ack.has("request_id") || ack.get("request_id").getAsLong() != analysisId)
                    fail("Analysis did not acknowledge this request. Retry is available.");
                // No deadline for the actual analysis and no destructive heartbeat watchdog.
            }));
        } catch (Exception e) { fail("Could not start the selected analysis server. Check its path and permissions, then Retry."); }
    }
    private JsonObject params() { JsonObject p = new JsonObject(); p.addProperty("path", path); return p; }
    private void onNotification(String method, JsonObject p) {
        if (p == null || !p.has("request_id") || p.get("request_id").getAsLong() != analysisId) return;
        if (state != State.ANALYZING && state != State.CANCELLING) return;
        if ("heap_analysis_progress".equals(method)) {
            // Cancellation progress is an acknowledgement, NOT worker termination.
            if (p.has("stage") && "cancelled".equals(p.get("stage").getAsString())) return;
            output.accept(WebviewEvents.progress(p));
        } else if ("heap_analysis_complete".equals(method)) {
            String status = p.has("status") ? p.get("status").getAsString() : "error";
            if ("completed".equals(status)) { state = State.READY; output.accept(WebviewEvents.analysis(p)); }
            else if ("cancelled".equals(status) || "canceled".equals(status)) {
                state = State.CANCELLED; output.accept(WebviewEvents.event("analysisCancelled"));
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
    public void query(String query, int page) { dispatch(() -> {
        if (state != State.READY || queryPending) { queryError("Wait for analysis and the previous query to finish.", query); return; }
        queryPending = true;
        JsonObject p = params(); p.addProperty("query", query); p.addProperty("page", Math.max(1, page)); p.addProperty("page_size", 500);
        long current = generation;
        client.request(++nextId, "execute_query", p, Duration.ofSeconds(30)).whenComplete((result, error) -> dispatch(() -> {
            if (current != generation || state != State.READY) return;
            queryPending = false;
            if (error != null) queryError("Query failed or timed out. Check its syntax or retry the query.", query);
            else { JsonObject message = WebviewEvents.event("queryResult"); message.add("result", result); message.addProperty("query", query); output.accept(message); }
        }));
    }); }
    private void queryError(String reason, String query) {
        JsonObject error = WebviewEvents.event("queryError"); error.addProperty("error", reason); error.addProperty("query", query); output.accept(error);
    }
    private void fail(String reason) {
        if (state == State.FAILED || state == State.CLOSED) return;
        ++generation; state = State.FAILED; queryPending = false;
        if (client != null) client.close();
        output.accept(WebviewEvents.error(reason));
    }
    @Override public void close() {
        dispatch(() -> { ++generation; state = State.CLOSED; if (client != null) client.close(); serial.shutdown(); });
    }
}
