package com.heaplens.session;

import com.google.gson.*;
import java.util.*;
import java.util.function.BiConsumer;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class DominatorQueriesTest {
    static JsonObject request(long objectId, String requestId) {
        JsonObject message = new JsonObject();
        message.addProperty("objectId", objectId); message.addProperty("requestId", requestId); return message;
    }
    @Test void callsOnlyChildrenWithCorrelatedArrayReplyIncludingEmptyLeaves() {
        List<JsonObject> events = new ArrayList<>();
        DominatorQueries feature = new DominatorQueries((method, params, reply) -> {
            assertEquals("get_children", method);
            assertEquals(Set.of("object_id"), params.keySet());
            assertEquals(42, params.get("object_id").getAsLong());
            reply.accept(new JsonArray(), null);
        }, events::add);
        JsonObject request = request(42, "tree-1");
        request.addProperty("path", "untrusted"); request.addProperty("method", "analyze_heap");
        feature.children(request);
        JsonObject result = events.getFirst();
        assertEquals("dominatorChildrenResult", result.get("command").getAsString());
        assertEquals("tree-1", result.get("requestId").getAsString());
        assertEquals(42, result.get("objectId").getAsLong());
        assertTrue(result.getAsJsonArray("children").isEmpty());
    }
    @Test void failuresAndMalformedResultsAreNotMisreportedAsLeaves() {
        for (JsonElement value : Arrays.asList(null, JsonNull.INSTANCE, new JsonObject(), new JsonPrimitive(42))) {
            List<JsonObject> events = new ArrayList<>();
            new DominatorQueries((method, params, reply) -> reply.accept(value, null), events::add).children(request(42, "t1"));
            assertEquals("dominatorChildrenError", events.getFirst().get("command").getAsString());
            assertFalse(events.getFirst().has("children"));
        }
    }
    @Test void rejectsMalformedAndLossyObjectIdsBeforeCallingServer() {
        DominatorQueries feature = new DominatorQueries((method, params, reply) -> fail("Unexpected read"), e -> fail("Unexpected event"));
        for (String value : List.of("null", "[]", "true", "\"42\"", "-1", "0", "1.5", "9007199254740992", "1e100")) {
            JsonObject request = request(42, "t1"); request.add("objectId", JsonParser.parseString(value));
            assertThrows(IllegalArgumentException.class, () -> feature.children(request), value);
        }
        for (String id : List.of("", "<script>", "x".repeat(81)))
            assertThrows(IllegalArgumentException.class, () -> feature.children(request(42, id)));
        assertThrows(IllegalArgumentException.class, () -> feature.children(new JsonObject()));
    }
    @Test void outOfOrderRepliesStayOwnedByTheOriginalNodeAndRequest() {
        List<BiConsumer<JsonElement, String>> replies = new ArrayList<>();
        List<JsonObject> events = new ArrayList<>();
        DominatorQueries feature = new DominatorQueries((method, params, reply) -> replies.add(reply), events::add);
        feature.children(request(42, "a")); feature.children(request(43, "b"));
        replies.get(1).accept(new JsonArray(), null); replies.get(0).accept(null, "Retry expansion");
        assertEquals(43, events.get(0).get("objectId").getAsLong());
        assertEquals("b", events.get(0).get("requestId").getAsString());
        assertEquals(42, events.get(1).get("objectId").getAsLong());
        assertEquals("a", events.get(1).get("requestId").getAsString());
        assertEquals("Retry expansion", events.get(1).get("error").getAsString());
    }
}
