package com.heaplens.ai;

import com.google.gson.JsonObject;
import java.util.concurrent.CompletableFuture;

/** Captured analysis capability. No page/provider can choose a path or RPC method. */
public interface InvestigationEngine {
    String identity();
    boolean current();
    CompletableFuture<JsonObject> read(JsonObject action,String jobId);
    void cancel(String jobId);
    @FunctionalInterface interface Capture { CompletableFuture<InvestigationEngine> capture(); }
}
