package com.heaplens.protocol;

import com.google.gson.JsonObject;
import com.google.gson.JsonElement;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;

/** Host-independent transport boundary. No IDE, rendering, or analysis policy. */
public interface RpcClient extends AutoCloseable {
    interface Listener {
        void notification(String method, JsonObject params);
        void failed(String reason);
    }
    void start(Listener listener);
    CompletableFuture<JsonObject> request(long id, String method, JsonObject params, Duration timeout);
    /** JSON-RPC also permits array/scalar results. Existing object-only ports remain valid. */
    default CompletableFuture<JsonElement> requestValue(long id, String method, JsonObject params, Duration timeout) {
        return request(id, method, params, timeout).thenApply(value -> value);
    }
    boolean isAlive();
    long pid();
    @Override void close();

    @FunctionalInterface
    interface Factory { RpcClient create() throws Exception; }
}
