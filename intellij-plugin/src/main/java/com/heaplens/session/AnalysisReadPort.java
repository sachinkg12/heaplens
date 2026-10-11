package com.heaplens.session;

import com.google.gson.*;
import java.util.function.BiConsumer;

/** Trusted capabilities read the current analysis; the session owns its path and generation. */
@FunctionalInterface
public interface AnalysisReadPort {
    void read(String method, JsonObject params, BiConsumer<JsonElement, String> reply);
}
