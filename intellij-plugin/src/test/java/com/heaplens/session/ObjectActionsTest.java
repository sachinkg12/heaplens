package com.heaplens.session;

import com.google.gson.*;
import com.heaplens.protocol.RpcResponseException;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class ObjectActionsTest {
    static JsonObject request(String command,long id) {
        JsonObject value=new JsonObject();value.addProperty("command",command);value.addProperty("objectId",id);value.addProperty("requestId","r-1");return value;
    }
    @Test void exposesOnlyAllowlistedReadsWithBoundedFlameParametersAndNoPagePath() {
        for(String command:List.of("gcRootPath","inspectObject","getReferrers","getDominatorSubtree")) {
            List<JsonObject> replies=new ArrayList<>();
            ObjectActions actions=new ObjectActions((method,params,callback)->{
                assertFalse(params.has("path"));assertEquals(42,params.get("object_id").getAsInt());
                if(command.equals("getDominatorSubtree")) {assertEquals(6,params.get("max_depth").getAsInt());assertEquals(20,params.get("max_children").getAsInt());}
                callback.accept(command.equals("getDominatorSubtree")?new JsonObject():new JsonArray(),null);
            },replies::add);
            JsonObject request=request(command,42);request.addProperty("path","/other/dump");request.addProperty("method","export_json");request.addProperty("maxDepth",999999);
            assertTrue(actions.register(new CommandRouter(Map.of())).dispatch(request.toString()));
            assertEquals("r-1",replies.getFirst().get("requestId").getAsString());assertFalse(replies.getFirst().has("error"));
            assertFalse(actions.register(new CommandRouter(Map.of())).dispatch("{\"command\":\"export_json\"}"));
        }
    }
    @Test void rejectsUnsafeIdsAndKeepsFailuresDistinctFromEmptyResults() {
        ObjectActions actions=new ObjectActions((m,p,reply)->{throw new AssertionError("No request allowed");},e->{});
        for(long id:List.of(-1L,0L,9007199254740992L)) assertThrows(IllegalArgumentException.class,()->actions.handle(request("inspectObject",id)));
        JsonObject fractional=request("inspectObject",1);fractional.addProperty("objectId",1.5);
        assertThrows(ArithmeticException.class,()->actions.handle(fractional));
        List<JsonObject> replies=new ArrayList<>();
        new ObjectActions((m,p,reply)->reply.accept(null,"Failed read"),replies::add).handle(request("getReferrers",42));
        assertTrue(replies.getFirst().has("error"));assertFalse(replies.getFirst().has("referrers"));
    }
    @Test void earlyProgressCarriesSummaryWithoutOtherHeapData() {
        JsonObject event=JsonParser.parseString("{\"stage\":\"graph_built\",\"summary\":{\"total_instances\":42},\"raw\":\"excluded\"}").getAsJsonObject();
        JsonObject progress=WebviewEvents.progress(event);
        assertEquals(42,progress.getAsJsonObject("summary").get("total_instances").getAsInt());assertFalse(progress.has("raw"));
    }
    @Test void queryDiagnosticsAndChatResultsRemainLocalAndCallerScoped() {
        assertEquals("Unknown column: x",RpcResponseException.display(new java.util.concurrent.CompletionException(new RpcResponseException("Unknown column: x")),"fallback"));
        assertEquals("fallback",RpcResponseException.display(new RuntimeException("do not expose"),"fallback"));
        List<JsonObject> events=new ArrayList<>();
        ChatQueries queries=new ChatQueries((q,p,reply)->{
            assertEquals("SELECT * FROM instances LIMIT 2",q);JsonObject result=WebviewEvents.event("queryResult");result.add("result",new JsonObject());reply.accept(result);
        },events::add);
        JsonObject request=request("aiRunQuery",1);request.addProperty("query","SELECT * FROM instances LIMIT 2");queries.run(request);
        assertEquals("aiQueryResult",events.getFirst().get("command").getAsString());assertEquals("r-1",events.getFirst().get("requestId").getAsString());
    }
}
