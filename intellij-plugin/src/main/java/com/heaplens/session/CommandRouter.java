package com.heaplens.session;

import com.google.gson.*;
import java.util.Map;
import java.util.function.Consumer;

/** Allowlisted registry: new capabilities register handlers, not orchestration branches. */
public final class CommandRouter {
    private final Map<String, Consumer<JsonObject>> handlers;
    public CommandRouter(Map<String, Consumer<JsonObject>> handlers) { this.handlers = Map.copyOf(handlers); }
    public boolean dispatch(String raw) {
        if (raw == null || raw.length() > 128 * 1024) return false;
        try {
            JsonObject message = JsonParser.parseString(raw).getAsJsonObject();
            Consumer<JsonObject> handler = handlers.get(message.get("command").getAsString());
            if (handler == null) return false;
            handler.accept(message);
            return true;
        } catch (RuntimeException invalid) { return false; }
    }
    public static CommandRouter forSession(HeapSession session, Runnable ready) {
        return new CommandRouter(Map.of(
            "ready", ignored -> ready.run(),
            "tabViewed", ignored -> { /* No telemetry in the prototype. */ },
            "cancelAnalysis", ignored -> session.cancel(),
            "retryAnalysis", ignored -> session.retry(),
            "executeQuery", m -> session.query(m.get("query").getAsString(),
                m.has("page") ? m.get("page").getAsInt() : 1)
        ));
    }
}
