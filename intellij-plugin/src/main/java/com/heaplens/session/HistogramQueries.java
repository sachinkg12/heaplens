package com.heaplens.session;

import com.google.gson.*;
import java.util.function.Consumer;

/** Bounded class drill-down. No process ownership, IDE APIs, or arbitrary SQL input. */
public final class HistogramQueries {
    private final QueryPort queries;
    private final Consumer<JsonObject> output;

    public HistogramQueries(QueryPort queries, Consumer<JsonObject> output) {
        this.queries = queries; this.output = output;
    }
    public void instances(JsonObject message) {
        String className = string(message, "className");
        String requestId = string(message, "requestId");
        if (className.isEmpty() || className.length() > 16384 || className.indexOf('\0') >= 0
                || !requestId.matches("[A-Za-z0-9_-]{1,80}"))
            throw new IllegalArgumentException("Invalid histogram request");
        String query = "SELECT object_id, node_type, class_name, shallow_size, retained_size FROM instances"
            + " WHERE class_name = '" + className.replace("'", "''") + "' ORDER BY retained_size DESC LIMIT 200";
        queries.query(query, 1, reply -> {
            boolean success = "queryResult".equals(reply.get("command").getAsString())
                && reply.has("result") && reply.get("result").isJsonObject();
            JsonObject event = WebviewEvents.event(success ? "histogramInstancesResult" : "histogramInstancesError");
            event.addProperty("requestId", requestId); event.addProperty("className", className);
            if (success) event.add("result", reply.get("result"));
            else event.addProperty("error", reply.has("error") ? reply.get("error").getAsString()
                : "Could not load instances. Select the class to try again.");
            output.accept(event);
        });
    }
    private static String string(JsonObject message, String key) {
        JsonElement value = message.get(key);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString())
            throw new IllegalArgumentException("Expected string: " + key);
        return value.getAsString();
    }
}
