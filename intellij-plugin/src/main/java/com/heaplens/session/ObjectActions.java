package com.heaplens.session;

import com.google.gson.*;
import java.math.BigDecimal;
import java.util.Map;
import java.util.function.Consumer;

/** Typed object reads; the page cannot supply RPC methods or another dump's path. */
public final class ObjectActions {
    private record Action(String method, String reply, String field, boolean array) { }
    private static final Map<String, Action> ACTIONS = Map.of(
        "gcRootPath", new Action("gc_root_path", "gcRootPathResponse", "path", true),
        "inspectObject", new Action("inspect_object", "inspectObjectResponse", "fields", true),
        "getReferrers", new Action("get_referrers", "referrersResponse", "referrers", true),
        "getDominatorSubtree", new Action("get_dominator_subtree", "dominatorSubtreeResponse", "subtree", false));
    private final AnalysisReadPort analysis;
    private final Consumer<JsonObject> output;
    public ObjectActions(AnalysisReadPort analysis, Consumer<JsonObject> output) { this.analysis=analysis; this.output=output; }
    public CommandRouter register(CommandRouter router) {
        for (String command : ACTIONS.keySet()) router=router.with(command, this::handle);
        return router;
    }
    public static long objectId(JsonObject message, boolean rootAllowed) {
        JsonElement raw=message.get("objectId");
        if(raw==null || !raw.isJsonPrimitive() || !raw.getAsJsonPrimitive().isNumber()) throw new IllegalArgumentException("Invalid object ID");
        long id=new BigDecimal(raw.getAsString()).longValueExact();
        if(id<(rootAllowed?0:1) || id>9007199254740991L) throw new IllegalArgumentException("Unsupported object ID");
        return id;
    }
    public static String requestId(JsonObject message) {
        JsonElement raw=message.get("requestId");
        if(raw==null || !raw.isJsonPrimitive() || !raw.getAsJsonPrimitive().isString()
            || !raw.getAsString().matches("[A-Za-z0-9_-]{1,80}")) throw new IllegalArgumentException("Invalid request ID");
        return raw.getAsString();
    }
    public void handle(JsonObject message) {
        String command=message.get("command").getAsString();
        Action action=ACTIONS.get(command);
        if(action==null) throw new IllegalArgumentException("Unsupported action");
        long id=objectId(message, command.equals("getDominatorSubtree")); String request=requestId(message);
        JsonObject params=new JsonObject(); params.addProperty("object_id",id);
        if(command.equals("getDominatorSubtree")) { params.addProperty("max_depth",6); params.addProperty("max_children",20); }
        analysis.read(action.method,params,(result,error)->{
            JsonObject reply=WebviewEvents.event(action.reply);
            reply.addProperty("objectId",id); reply.addProperty("requestId",request);
            boolean valid=result!=null && (action.array ? result.isJsonArray() : result.isJsonObject());
            if(error!=null || !valid) reply.addProperty("error",error!=null?error:"No data returned for this object.");
            else reply.add(action.field,result);
            output.accept(reply);
        });
    }
}
