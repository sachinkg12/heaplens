package com.heaplens.session;

import com.google.gson.JsonObject;
import java.util.function.Consumer;

/** Execute a query inside the current session, delivering only to its caller. */
@FunctionalInterface
public interface QueryPort {
    void query(String query, int page, Consumer<JsonObject> reply);
}
