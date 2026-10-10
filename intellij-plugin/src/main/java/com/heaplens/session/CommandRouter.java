package com.heaplens.session;

import com.google.gson.*;
import java.util.Map;
import java.util.HashMap;
import java.util.function.Consumer;

/** Allowlisted registry: new capabilities register handlers, not orchestration branches. */
public final class CommandRouter {
    private final Map<String, Consumer<JsonObject>> handlers;
    private final Consumer<String> observer;
    public CommandRouter(Map<String, Consumer<JsonObject>> handlers) { this(handlers,ignored->{}); }
    private CommandRouter(Map<String, Consumer<JsonObject>> handlers,Consumer<String> observer) {this.handlers=Map.copyOf(handlers);this.observer=observer;}
    public CommandRouter observed(Consumer<String> observer){return new CommandRouter(handlers,observer);}
    public CommandRouter with(String command, Consumer<JsonObject> handler) {
        Map<String, Consumer<JsonObject>> extended = new HashMap<>(handlers);
        if (extended.putIfAbsent(command, handler) != null)
            throw new IllegalArgumentException("Capability already registered: " + command);
        return new CommandRouter(extended,observer);
    }
    public boolean dispatch(String raw) {
        if (raw == null || raw.length() > 17 * 1024 * 1024) return false;
        try {
            JsonObject message = JsonParser.parseString(raw).getAsJsonObject();
            String command=message.get("command").getAsString();
            if(raw.length()>128*1024 && !java.util.Set.of("copyReportText","exportHistogramCsv","exportCompareCsv","exportCompareMarkdown").contains(command)) return false;
            Consumer<JsonObject> handler = handlers.get(message.get("command").getAsString());
            if (handler == null) return false;
            try {observer.accept(command);}catch(RuntimeException ignored){/* Optional diagnostics cannot suppress a command. */}
            handler.accept(message);
            return true;
        } catch (RuntimeException invalid) { return false; }
    }
    public static CommandRouter forSession(HeapSession session, Runnable ready) {
        return new CommandRouter(Map.of(
            "ready", ignored -> ready.run(),
            "tabViewed", m -> session.viewed(m.has("tab")?m.get("tab").getAsString():"unknown"),
            "cancelAnalysis", ignored -> session.cancel(),
            "retryAnalysis", ignored -> session.retry(),
            "executeQuery", m -> session.query(m.get("query").getAsString(),
                m.has("page") ? m.get("page").getAsInt() : 1)
        ));
    }
}
