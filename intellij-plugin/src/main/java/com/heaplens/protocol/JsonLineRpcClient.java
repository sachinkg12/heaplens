package com.heaplens.protocol;

import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** One private child process, newline JSON-RPC, bounded messages and request deadlines. */
public final class JsonLineRpcClient implements RpcClient {
    private static final int MAX_LINE = 32 * 1024 * 1024;
    private final Process process;
    private final BufferedWriter stdin;
    private final ConcurrentMap<Long, CompletableFuture<JsonObject>> pending = new ConcurrentHashMap<>();
    private final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "heaplens-rpc-timeouts"); t.setDaemon(true); return t;
    });
    private final AtomicBoolean closed = new AtomicBoolean();
    private final AtomicBoolean started = new AtomicBoolean();
    private Listener listener;

    public JsonLineRpcClient(Path binary) throws IOException { this(List.of(binary.toString())); }

    // A list, never a shell command. Kept public for isolated subprocess protocol tests.
    public JsonLineRpcClient(List<String> command) throws IOException {
        process = new ProcessBuilder(command).start();
        stdin = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
    }

    @Override public void start(Listener value) {
        if (!started.compareAndSet(false, true)) throw new IllegalStateException("Client already started");
        listener = value;
        Thread.ofVirtual().name("heaplens-stdout").start(this::readStdout);
        Thread.ofVirtual().name("heaplens-stderr").start(() -> {
            // Drain so the child cannot deadlock. Do not log paths, queries, or heap values.
            try (InputStream input = process.getErrorStream()) { input.transferTo(OutputStream.nullOutputStream()); }
            catch (IOException ignored) { }
        });
    }

    @Override public CompletableFuture<JsonObject> request(long id, String method, JsonObject params, Duration timeout) {
        CompletableFuture<JsonObject> result = new CompletableFuture<>();
        if (closed.get()) return CompletableFuture.failedFuture(new IOException("Analysis server is unavailable"));
        if (pending.putIfAbsent(id, result) != null) throw new IllegalArgumentException("Duplicate request ID");
        try {
            ScheduledFuture<?> deadline = timers.schedule(() -> {
                if (pending.remove(id, result)) result.completeExceptionally(new IOException("Request acknowledgement timed out: " + method));
            }, timeout.toMillis(), TimeUnit.MILLISECONDS);
            result.whenComplete((v, e) -> { deadline.cancel(false); pending.remove(id, result); });
            JsonObject message = new JsonObject();
            message.addProperty("jsonrpc", "2.0"); message.addProperty("id", id);
            message.addProperty("method", method); message.add("params", params);
            synchronized (stdin) { stdin.write(message.toString()); stdin.newLine(); stdin.flush(); }
        } catch (IOException | RejectedExecutionException e) { result.completeExceptionally(e); }
        return result;
    }

    private void readStdout() {
        try (Reader input = new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8)) {
            StringBuilder line = new StringBuilder();
            char[] buffer = new char[8192]; int count;
            while ((count = input.read(buffer)) != -1) {
                for (int i = 0; i < count; i++) {
                    char c = buffer[i];
                    if (c == '\n') { if (!line.isEmpty()) receive(line.toString()); line.setLength(0); }
                    else if (c != '\r') {
                        if (line.length() >= MAX_LINE) throw new IOException("Server message exceeds prototype size limit");
                        line.append(c);
                    }
                }
            }
            fail(line.isEmpty() ? "Analysis server exited" : "Analysis server returned truncated JSON");
        } catch (Exception e) { fail("Analysis server returned invalid data or closed its output"); }
    }

    private void receive(String line) {
        JsonObject message = JsonParser.parseString(line).getAsJsonObject();
        if (!message.has("jsonrpc") || !"2.0".equals(message.get("jsonrpc").getAsString()))
            throw new IllegalArgumentException("Invalid JSON-RPC envelope");
        if (message.has("id")) {
            long id = message.get("id").getAsLong();
            CompletableFuture<JsonObject> future = pending.remove(id);
            if (future == null) return; // Late response after timeout; never match another request.
            if (message.has("error")) future.completeExceptionally(new IOException("Analysis server rejected the request"));
            else if (message.has("result") && message.get("result").isJsonObject()) future.complete(message.getAsJsonObject("result"));
            else future.completeExceptionally(new IOException("Invalid RPC result"));
        } else {
            listener.notification(message.get("method").getAsString(), message.getAsJsonObject("params"));
        }
    }

    private void fail(String reason) {
        if (!closed.compareAndSet(false, true)) return;
        terminate(reason);
        listener.failed(reason);
    }
    private void terminate(String reason) {
        pending.values().forEach(f -> f.completeExceptionally(new IOException(reason)));
        pending.clear(); timers.shutdownNow();
        process.destroy();
        Thread.ofVirtual().name("heaplens-process-reap").start(() -> {
            try { if (!process.waitFor(500, TimeUnit.MILLISECONDS)) process.destroyForcibly(); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); process.destroyForcibly(); }
        });
    }
    @Override public boolean isAlive() { return !closed.get() && process.isAlive(); }
    @Override public long pid() { return process.pid(); }
    @Override public void close() { if (closed.compareAndSet(false, true)) terminate("Editor closed"); }
}
