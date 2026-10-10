package com.heaplens.session;

import com.google.gson.*;
import java.util.function.Consumer;

/** Explicit Run Query clicks use a private reply channel, never an automatic AI tool call. */
public final class ChatQueries {
    private final QueryPort queries;private final Consumer<JsonObject> output;
    public ChatQueries(QueryPort queries,Consumer<JsonObject> output){this.queries=queries;this.output=output;}
    public void run(JsonObject request){
        String id=ObjectActions.requestId(request);
        JsonElement value=request.get("query");
        if(value==null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString())throw new IllegalArgumentException("Invalid query");
        String query=value.getAsString();if(query.isBlank() || query.length()>32000)throw new IllegalArgumentException("Query too long");
        queries.query(query,1,reply->{
            JsonObject event=reply.deepCopy();event.addProperty("command",reply.get("command").getAsString().equals("queryResult")?"aiQueryResult":"aiQueryError");
            event.addProperty("requestId",id);output.accept(event);
        });
    }
}
