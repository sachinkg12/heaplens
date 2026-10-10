package com.heaplens.session;

import com.google.gson.*;
import com.heaplens.intellij.NativeServer;
import com.heaplens.protocol.JsonLineRpcClient;
import java.nio.file.*;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** Opt-in smoke against an extracted distribution, not a repo executable override. */
class BundledServerTest {
    @Test void extractedDistributionAnalyzesQueriesRetriesAndStops() throws Exception {
        String install = System.getProperty("heaplens.test.pluginRoot"), dump = System.getProperty("heaplens.test.dump");
        assumeTrue(install != null && dump != null, "Supply an extracted plugin root and fixture to test the distribution");
        Path root = Path.of(install);
        Path bundled = NativeServer.bundled(root, System.getProperty("os.name"), System.getProperty("os.arch"));
        assertTrue(bundled.startsWith(root.toRealPath()));
        List<JsonObject> events = new CopyOnWriteArrayList<>();
        HeapSession session = new HeapSession(() -> new JsonLineRpcClient(NativeServer.bundled(root,
            System.getProperty("os.name"), System.getProperty("os.arch"))), Path.of(dump), events::add);
        long pid = -1;
        try {
            session.start(); ready(session);
            pid = session.pid();
            assertTrue(ProcessHandle.of(pid).orElseThrow().destroyForcibly());
            RealEngineTest.until(() -> session.state() == HeapSession.State.FAILED);
            long retired = pid;
            session.retry();
            RealEngineTest.until(() -> session.pid() != retired);
            ready(session); assertNotEquals(pid, session.pid()); pid = session.pid();
            session.query("SELECT class_name, retained_size FROM class_histogram ORDER BY retained_size DESC LIMIT 3", 1);
            RealEngineTest.until(() -> events.stream().anyMatch(e -> "queryResult".equals(e.get("command").getAsString())));
            JsonObject result = events.stream().filter(e -> "queryResult".equals(e.get("command").getAsString())).findFirst().orElseThrow();
            assertEquals(3, result.getAsJsonObject("result").getAsJsonArray("rows").size());
            JsonObject analysis = events.stream().filter(e -> "analysisComplete".equals(e.get("command").getAsString())).toList().getLast();
            long entry = analysis.getAsJsonArray("topLayers").get(0).getAsJsonObject().get("object_id").getAsLong();
            List<JsonObject> tree = new CopyOnWriteArrayList<>();
            new DominatorQueries(session::read, tree::add).children(DominatorQueriesTest.request(entry, "packaged-tree"));
            RealEngineTest.until(() -> !tree.isEmpty());
            assertEquals("dominatorChildrenResult", tree.getFirst().get("command").getAsString());
            assertTrue(tree.getFirst().get("children").isJsonArray());
        } finally {
            session.close();
            RealEngineTest.until(() -> session.state() == HeapSession.State.CLOSED);
            long child = pid;
            if (child > 0) RealEngineTest.until(() -> ProcessHandle.of(child).map(p -> !p.isAlive()).orElse(true));
        }
    }
    private void ready(HeapSession session) {
        RealEngineTest.until(() -> session.state() == HeapSession.State.READY || session.state() == HeapSession.State.FAILED);
        assertEquals(HeapSession.State.READY, session.state());
    }
}
