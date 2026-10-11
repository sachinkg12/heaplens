package com.heaplens.source;

import com.google.gson.*;
import java.util.Locale;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import static com.heaplens.source.SourceNavigationPort.Status;

/** One user-initiated lookup per editor, fenced across retry, disposal and late callbacks. */
public final class SourceNavigation {
    private final SourceNavigationPort host;
    private final BooleanSupplier available;
    private final Consumer<JsonObject> output;
    private Object pending;

    public SourceNavigation(SourceNavigationPort host, BooleanSupplier available, Consumer<JsonObject> output) {
        this.host = host; this.available = available; this.output = output;
    }
    private static String string(JsonObject message, String key) {
        JsonElement value = message.get(key);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString())
            throw new IllegalArgumentException("Invalid source request");
        return value.getAsString();
    }
    public synchronized void open(JsonObject message) {
        String className = string(message, "className"), requestId = string(message, "requestId");
        SourceTarget target = SourceTarget.parse(className);
        if (!requestId.matches("[A-Za-z0-9_-]{1,80}")) throw new IllegalArgumentException("Invalid request ID");
        if (!available.getAsBoolean()) { emit(className, requestId, Status.UNAVAILABLE); return; }
        if (pending != null) { emit(className, requestId, Status.BUSY); return; }
        Object token = new Object(); pending = token;
        try { host.open(target, () -> current(token), status -> complete(token, className, requestId, status)); }
        catch (RuntimeException failure) { complete(token, className, requestId, Status.ERROR); }
    }
    private synchronized boolean current(Object token) { return pending == token && available.getAsBoolean(); }
    private synchronized void complete(Object token, String className, String requestId, Status status) {
        if (!current(token)) return;
        if (status != Status.SEARCHING && status != Status.INDEXING) pending = null;
        emit(className, requestId, status);
    }
    private void emit(String className, String requestId, Status status) {
        JsonObject event = new JsonObject();
        event.addProperty("command", "sourceNavigationResult");
        event.addProperty("className", className); event.addProperty("requestId", requestId);
        event.addProperty("status", status.name().toLowerCase(Locale.ROOT).replace('_', '-'));
        output.accept(event);
    }
    public synchronized void invalidate() { pending = null; }
}
