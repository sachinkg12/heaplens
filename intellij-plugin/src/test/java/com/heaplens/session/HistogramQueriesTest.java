package com.heaplens.session;

import com.google.gson.*;
import java.util.*;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class HistogramQueriesTest {
    static JsonObject request(String name, String id) {
        JsonObject message = new JsonObject();
        message.addProperty("className", name); message.addProperty("requestId", id); return message;
    }
    @Test void generatesBoundedEscapedQueryAndCorrelatedReply() {
        List<JsonObject> events = new ArrayList<>();
        HistogramQueries feature = new HistogramQueries((sql, page, reply) -> {
            assertEquals(1, page);
            assertEquals("SELECT object_id, node_type, class_name, shallow_size, retained_size FROM instances"
                + " WHERE class_name = 'odd''Name$Inner' ORDER BY retained_size DESC LIMIT 200", sql);
            JsonObject event = WebviewEvents.event("queryResult");
            event.add("result", new JsonObject()); reply.accept(event);
        }, events::add);
        feature.instances(request("odd'Name$Inner", "histogram-3"));
        JsonObject event = events.getFirst();
        assertEquals("histogramInstancesResult", event.get("command").getAsString());
        assertEquals("histogram-3", event.get("requestId").getAsString());
        assertEquals("odd'Name$Inner", event.get("className").getAsString());
        assertFalse(event.has("query"));
    }
    @Test void errorsRemainInTheirOwnResponseChannel() {
        List<JsonObject> events = new ArrayList<>();
        HistogramQueries feature = new HistogramQueries((sql, page, reply) -> {
            JsonObject error = WebviewEvents.event("queryError");
            error.addProperty("error", "Wait for analysis"); reply.accept(error);
        }, events::add);
        feature.instances(request("A", "h1"));
        assertEquals("histogramInstancesError", events.getFirst().get("command").getAsString());
        assertEquals("Wait for analysis", events.getFirst().get("error").getAsString());
    }
    @Test void malformedRequestsCannotInvokeEngine() {
        HistogramQueries feature = new HistogramQueries((sql, page, reply) -> fail("Unexpected query"), event -> fail("Unexpected reply"));
        for (JsonObject invalid : List.of(new JsonObject(), request("", "h1"), request("A", ""),
                request("A", "x".repeat(81)), request("A", "<script>"), request("x".repeat(16385), "h1"), request("A\0B", "h1")))
            assertThrows(IllegalArgumentException.class, () -> feature.instances(invalid));
        JsonObject invalid = request("A", "h1"); invalid.add("className", new JsonArray());
        assertThrows(IllegalArgumentException.class, () -> feature.instances(invalid));
    }
    @Test void routingExtensionsAreImmutableAndCannotReplaceExistingCommands() {
        List<JsonObject> events = new ArrayList<>();
        CommandRouter base = new CommandRouter(Map.of("ready", events::add));
        HistogramQueries feature = new HistogramQueries((sql, page, reply) -> { }, events::add);
        CommandRouter extended = base.with("histogramInstances", feature::instances);
        JsonObject message = request("A", "h1"); message.addProperty("command", "histogramInstances");
        assertFalse(base.dispatch(message.toString()));
        assertTrue(extended.dispatch(message.toString()));
        assertFalse(extended.dispatch("{\"command\":\"histogramInstances\"}"));
        assertThrows(IllegalArgumentException.class, () -> extended.with("ready", ignored -> { }));
    }
    @Test void overlappingRepliesKeepTheirOriginalClassAndRequestId() {
        List<Consumer<JsonObject>> replies = new ArrayList<>();
        List<JsonObject> events = new ArrayList<>();
        HistogramQueries feature = new HistogramQueries((sql, page, reply) -> replies.add(reply), events::add);
        feature.instances(request("A", "h1")); feature.instances(request("B", "h2"));
        JsonObject result = WebviewEvents.event("queryResult"); result.add("result", new JsonObject());
        replies.get(1).accept(result); replies.get(0).accept(result);
        assertEquals("B", events.get(0).get("className").getAsString());
        assertEquals("h2", events.get(0).get("requestId").getAsString());
        assertEquals("A", events.get(1).get("className").getAsString());
        assertEquals("h1", events.get(1).get("requestId").getAsString());
    }
    @Test void nullResultIsReportedAsAnErrorNotAStuckPreview() {
        List<JsonObject> events = new ArrayList<>();
        HistogramQueries feature = new HistogramQueries((sql, page, reply) -> {
            JsonObject result = WebviewEvents.event("queryResult"); result.add("result", JsonNull.INSTANCE); reply.accept(result);
        }, events::add);
        feature.instances(request("A", "h1"));
        assertEquals("histogramInstancesError", events.getFirst().get("command").getAsString());
    }
}
