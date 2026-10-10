package com.heaplens.source;

import com.google.gson.*;
import com.heaplens.session.CommandRouter;
import java.util.*;
import java.util.function.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static com.heaplens.source.SourceNavigationPort.Status;

class SourceNavigationTest {
    static JsonObject request(String id) {
        JsonObject message = new JsonObject();
        message.addProperty("className", "example.Outer$Inner"); message.addProperty("requestId", id); return message;
    }
    static final class Host implements SourceNavigationPort {
        final List<Consumer<Status>> replies = new ArrayList<>();
        final List<BooleanSupplier> active = new ArrayList<>();
        public void open(SourceTarget target, BooleanSupplier live, Consumer<Status> reply) {
            assertEquals(new SourceTarget("Outer.java", "example"), target);
            active.add(live); replies.add(reply);
        }
    }
    @Test void opensOnlyNormalizedTargetAndRepliesContainNoSourcePathsOrContents() {
        Host host = new Host(); List<JsonObject> events = new ArrayList<>();
        SourceNavigation feature = new SourceNavigation(host, () -> true, events::add);
        JsonObject request = request("s1"); request.addProperty("path", "/private/secret.java"); request.addProperty("code", "private source");
        feature.open(request); host.replies.getFirst().accept(Status.INDEXING); host.replies.getFirst().accept(Status.OPENED);
        assertEquals(2, events.size());
        assertEquals("indexing", events.getFirst().get("status").getAsString());
        JsonObject result = events.getLast();
        assertEquals(Set.of("command", "className", "requestId", "status"), result.keySet());
        assertEquals("sourceNavigationResult", result.get("command").getAsString());
        assertEquals("s1", result.get("requestId").getAsString());
        assertEquals("opened", result.get("status").getAsString());
        assertFalse(host.active.getFirst().getAsBoolean());
        feature.open(request("s2")); assertEquals(2, host.replies.size()); // Reopen, not one-shot.
    }
    @Test void boundsPendingLookupAndAllowsRetryAfterEveryTerminalOutcome() {
        for (Status status : List.of(Status.NOT_FOUND, Status.ERROR, Status.CANCELLED, Status.TOO_MANY)) {
            Host host = new Host(); List<JsonObject> events = new ArrayList<>();
            SourceNavigation feature = new SourceNavigation(host, () -> true, events::add);
            feature.open(request("a")); feature.open(request("b"));
            assertEquals(1, host.replies.size()); assertEquals("busy", events.getFirst().get("status").getAsString());
            host.replies.getFirst().accept(status); feature.open(request("c")); assertEquals(2, host.replies.size());
        }
    }
    @Test void resetDisposalAndUnavailableSessionPreventLateNavigationAndReplies() {
        Host host = new Host(); List<JsonObject> events = new ArrayList<>(); AtomicBoolean available = new AtomicBoolean(true);
        SourceNavigation feature = new SourceNavigation(host, available::get, events::add);
        feature.open(request("old")); feature.invalidate(); feature.open(request("new"));
        assertFalse(host.active.getFirst().getAsBoolean()); assertTrue(host.active.getLast().getAsBoolean());
        host.replies.getFirst().accept(Status.OPENED); assertTrue(events.isEmpty());
        available.set(false); assertFalse(host.active.getLast().getAsBoolean());
        host.replies.getLast().accept(Status.OPENED); assertTrue(events.isEmpty());
        feature.open(request("unavailable")); assertEquals("unavailable", events.getFirst().get("status").getAsString());
        assertEquals(2, host.replies.size());
    }
    @Test void editorsDoNotSharePendingLookups() {
        Host one = new Host(), two = new Host();
        SourceNavigation first = new SourceNavigation(one, () -> true, ignored -> {});
        SourceNavigation second = new SourceNavigation(two, () -> true, ignored -> {});
        first.open(request("same")); second.open(request("same")); first.invalidate();
        assertFalse(one.active.getFirst().getAsBoolean()); assertTrue(two.active.getFirst().getAsBoolean());
    }
    @Test void malformedCommandsCannotReachHost() {
        SourceNavigation feature = new SourceNavigation((target, active, reply) -> fail("Unexpected host call"), () -> true, ignored -> {});
        CommandRouter router = new CommandRouter(Map.of()).with("openProjectSource", feature::open);
        for (String bad : List.of("../Secret", "a.Foo/../../Secret", "a.\"Foo")) {
            JsonObject request = request("a"); request.addProperty("command", "openProjectSource"); request.addProperty("className", bad);
            assertFalse(router.dispatch(request.toString()));
        }
        for (String bad : List.of("", "../", "x".repeat(81))) assertThrows(IllegalArgumentException.class, () -> feature.open(request(bad)));
        JsonObject bad = request("a"); bad.addProperty("className", 42);
        assertThrows(IllegalArgumentException.class, () -> feature.open(bad));
        assertFalse(router.dispatch("{\"command\":\"fixWithAi\"}"));
        assertFalse(router.dispatch("{\"command\":\"openFile\",\"path\":\"/tmp/private\"}"));
    }
    @Test void unexpectedHostFailureReleasesLookupWithoutLeakingExceptionDetails() {
        List<JsonObject> events = new ArrayList<>();
        SourceNavigation feature = new SourceNavigation((target, active, reply) -> { throw new IllegalStateException("/private/source token=secret"); }, () -> true, events::add);
        feature.open(request("a")); feature.open(request("b")); assertEquals(2, events.size());
        assertEquals("error", events.getLast().get("status").getAsString());
        assertFalse(events.toString().contains("secret"));
    }
}
