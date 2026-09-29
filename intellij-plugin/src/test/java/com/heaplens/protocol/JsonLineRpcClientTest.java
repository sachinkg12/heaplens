package com.heaplens.protocol;

import com.google.gson.JsonObject;
import java.nio.file.Path;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;

class JsonLineRpcClientTest {
    RpcClient client;
    BlockingQueue<String> failures = new LinkedBlockingQueue<>();
    @BeforeEach void start() throws Exception {
        String cp = System.getProperty("heaplens.test.childClasspath");
        client = new JsonLineRpcClient(List.of(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
            "-cp", cp, FakeServer.class.getName()));
        client.start(new RpcClient.Listener() {
            public void notification(String method, JsonObject p) { }
            public void failed(String reason) { failures.add(reason); }
        });
    }
    @AfterEach void close() { if (client != null) client.close(); }
    @Test void realProcessRoundTripsUnicodeQuotesAndSpaces() throws Exception {
        JsonObject p = new JsonObject(); p.addProperty("query", "SELECT '東京 </script> \" spaced' FROM instances");
        assertEquals(p, client.request(1, "echo", p, Duration.ofSeconds(3)).get(4, TimeUnit.SECONDS));
    }
    @Test void timeoutDoesNotKillHealthyServer() throws Exception {
        assertThrows(ExecutionException.class, () -> client.request(1, "silent", new JsonObject(), Duration.ofMillis(30)).get());
        assertTrue(client.isAlive());
        assertNotNull(client.request(2, "echo", new JsonObject(), Duration.ofSeconds(3)).get());
    }
    @Test void invalidJsonRejectsPendingAndReportsFailure() throws Exception { rejects("malformed"); }
    @Test void truncatedJsonRejectsPendingAndReportsFailure() throws Exception { rejects("truncated"); }
    @Test void oversizedFrameFailsBoundedly() throws Exception { rejects("oversized"); }
    private void rejects(String method) throws Exception {
        assertThrows(ExecutionException.class, () -> client.request(1, method, new JsonObject(), Duration.ofSeconds(5)).get(6, TimeUnit.SECONDS));
        assertNotNull(failures.poll(5, TimeUnit.SECONDS)); assertFalse(client.isAlive());
    }
    @Test void intentionalCloseReapsOnlyOwnedChildWithoutCrashEvent() throws Exception {
        long pid = client.pid(); client.close();
        ProcessHandle.of(pid).ifPresent(p -> { try { p.onExit().get(3, TimeUnit.SECONDS); } catch (Exception e) { throw new AssertionError(e); } });
        assertTrue(failures.isEmpty()); assertFalse(client.isAlive());
    }
}
