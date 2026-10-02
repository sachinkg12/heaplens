package com.heaplens.protocol;

import com.google.gson.JsonObject;
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
    boolean isAlive();
    long pid();
    @Override void close();

    @FunctionalInterface
    interface Factory { RpcClient create() throws Exception; }
}
