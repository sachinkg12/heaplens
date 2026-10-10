package com.heaplens.session;

import com.google.gson.*;
import java.math.BigDecimal;
import java.util.function.Consumer;

/** Only immediate dominator children; no process ownership, SQL or arbitrary RPC passthrough. */
public final class DominatorQueries {
    private final AnalysisReadPort analysis;
    private final Consumer<JsonObject> output;
    public DominatorQueries(AnalysisReadPort analysis, Consumer<JsonObject> output) {
        this.analysis = analysis; this.output = output;
    }
    public void children(JsonObject message) {
        JsonElement rawId = message.get("objectId"), rawRequest = message.get("requestId");
        if (rawId == null || !rawId.isJsonPrimitive() || !rawId.getAsJsonPrimitive().isNumber()
                || rawRequest == null || !rawRequest.isJsonPrimitive() || !rawRequest.getAsJsonPrimitive().isString())
            throw new IllegalArgumentException("Invalid dominator request");
        long objectId;
        try { objectId = new BigDecimal(rawId.getAsString()).longValueExact(); }
        catch (ArithmeticException | NumberFormatException invalid) { throw new IllegalArgumentException("Invalid object ID"); }
        String requestId = rawRequest.getAsString();
        // The existing shared webview represents IDs as JS numbers. Never silently round an address.
        if (objectId <= 0 || objectId > 9007199254740991L || !requestId.matches("[A-Za-z0-9_-]{1,80}"))
            throw new IllegalArgumentException("Invalid dominator request");
        JsonObject params = new JsonObject(); params.addProperty("object_id", objectId);
        analysis.read("get_children", params, (value, error) -> {
            boolean success = error == null && value != null && value.isJsonArray();
            JsonObject event = WebviewEvents.event(success ? "dominatorChildrenResult" : "dominatorChildrenError");
            event.addProperty("objectId", objectId); event.addProperty("requestId", requestId);
            if (success) event.add("children", value);
            else event.addProperty("error", error != null ? error : "Invalid children response. Expand the row to retry.");
            output.accept(event);
        });
    }
}
