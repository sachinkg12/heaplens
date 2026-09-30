package com.heaplens.session;

import com.google.gson.*;
import com.heaplens.protocol.JsonLineRpcClient;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.BooleanSupplier;
import java.util.stream.Stream;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** Opt-in read-only HPROF tests against the exact server used by the editor. */
class RealEngineTest {
    String binary;
    Path dump;
    @BeforeEach void inputs() {
        binary = System.getProperty("heaplens.test.server");
        String path = System.getProperty("heaplens.test.dump");
        if (Boolean.getBoolean("heaplens.test.ci"))
            assertTrue(binary != null && path != null, "CI must provide its generated fixture and server");
        else assumeTrue(binary != null && path != null, "Supply explicit server and dump properties");
        assertTrue(Files.isExecutable(Path.of(binary)), "Explicit server must exist and be executable");
        dump = Path.of(path); assertTrue(Files.isRegularFile(dump));
    }
    static void until(BooleanSupplier condition) {
        long end = System.nanoTime() + Duration.ofSeconds(30).toNanos();
        while (!condition.getAsBoolean() && System.nanoTime() < end) {
            try { Thread.sleep(10); } catch (InterruptedException e) { throw new AssertionError(e); }
        }
        assertTrue(condition.getAsBoolean(), "Engine did not reach expected state");
    }
    final class Run implements AutoCloseable {
        final List<JsonObject> events = new CopyOnWriteArrayList<>();
        final HeapSession session;
        Run(Path file, boolean legacy) {
            session = new HeapSession(() -> new JsonLineRpcClient(legacy ? List.of(binary, "--legacy") : List.of(binary)), file, events::add);
            session.start(); ready();
        }
        void ready() {
            until(() -> session.state() == HeapSession.State.READY || session.state() == HeapSession.State.FAILED);
            assertEquals(HeapSession.State.READY, session.state(), "Analysis must complete");
            until(() -> events.stream().anyMatch(e -> "analysisComplete".equals(e.get("command").getAsString())));
        }
        JsonObject analysis() {
            return events.stream().filter(e -> "analysisComplete".equals(e.get("command").getAsString())).toList().getLast();
        }
        JsonObject query(String query) {
            events.removeIf(e -> Set.of("queryResult", "queryError").contains(e.get("command").getAsString()));
            session.query(query, 1);
            until(() -> events.stream().anyMatch(e -> Set.of("queryResult", "queryError").contains(e.get("command").getAsString())));
            JsonObject result = events.stream().filter(e -> Set.of("queryResult", "queryError").contains(e.get("command").getAsString())).findFirst().orElseThrow();
            assertEquals("queryResult", result.get("command").getAsString(), result.toString());
            return result.getAsJsonObject("result");
        }
        JsonObject instances(String className) {
            List<JsonObject> replies = new CopyOnWriteArrayList<>();
            JsonObject request = new JsonObject();
            request.addProperty("className", className); request.addProperty("requestId", "real-histogram");
            new HistogramQueries(session::query, replies::add).instances(request);
            until(() -> !replies.isEmpty());
            JsonObject reply = replies.getFirst();
            assertEquals("histogramInstancesResult", reply.get("command").getAsString(), reply.toString());
            assertEquals(className, reply.get("className").getAsString());
            assertEquals("real-histogram", reply.get("requestId").getAsString());
            return reply.getAsJsonObject("result");
        }
        @Override public void close() { session.close(); until(() -> session.state() == HeapSession.State.CLOSED); }
    }
    @Test @Tag("local-fixture") void layoutDefaultMatchesFivePreviouslyMatVerifiedObjects() {
        assumeTrue(dump.getFileName().toString().equals("layout-default.hprof"));
        try (Run run = new Run(dump, false)) {
            JsonArray rows = run.query("SELECT object_id, shallow_size, retained_size FROM instances WHERE object_id = 14176762104 OR object_id = 14176760392 OR object_id = 14176760768 OR object_id = 14176766104 OR object_id = 14176776512 ORDER BY object_id").getAsJsonArray("rows");
            assertEquals(5, rows.size());
            Map<Long, Long> expected = Map.of(14176762104L,40L,14176760392L,16L,14176760768L,24L,14176766104L,32L,14176776512L,152L);
            for (JsonElement row : rows) {
                JsonArray cells = row.getAsJsonArray();
                assertEquals(expected.get(cells.get(0).getAsLong()).longValue(), cells.get(1).getAsLong());
                assertEquals(cells.get(1), cells.get(2));
            }
        }
    }
    @Test void killAfterCompletionRetryAndQueryUseNewProcess() {
        try (Run run = new Run(dump, false)) {
            JsonObject before = run.analysis().getAsJsonObject("summary");
            long original = run.session.pid();
            assertTrue(ProcessHandle.of(original).orElseThrow().destroyForcibly()); // Only this test-owned child.
            until(() -> run.session.state() == HeapSession.State.FAILED);
            run.session.retry();
            until(() -> run.session.pid() != original);
            run.ready(); assertNotEquals(original, run.session.pid());
            assertEquals(before, run.analysis().getAsJsonObject("summary"));
            assertFalse(run.query("SELECT class_name, retained_size FROM class_histogram ORDER BY retained_size DESC LIMIT 3").getAsJsonArray("rows").isEmpty());
            assertFalse(run.instances("java.lang.String").getAsJsonArray("rows").isEmpty());
        }
    }
    @Test void histogramDtoMatchesHeapqlForTopClasses() {
        for (boolean legacy : List.of(false, true)) try (Run run = new Run(dump, legacy)) {
            Map<String, JsonObject> histogram = new HashMap<>();
            for (JsonElement value : run.analysis().getAsJsonArray("classHistogram")) {
                JsonObject entry = value.getAsJsonObject();
                histogram.put(entry.get("class_name").getAsString(), entry);
            }
            JsonArray rows = run.query("SELECT class_name, instance_count, shallow_size, retained_size"
                + " FROM class_histogram ORDER BY retained_size DESC LIMIT 20").getAsJsonArray("rows");
            assertFalse(rows.isEmpty());
            for (JsonElement value : rows) {
                JsonArray row = value.getAsJsonArray();
                JsonObject entry = histogram.get(row.get(0).getAsString());
                assertNotNull(entry);
                assertEquals(entry.get("instance_count"), row.get(1));
                assertEquals(entry.get("shallow_size"), row.get(2));
                assertEquals(entry.get("retained_size"), row.get(3));
            }
        }
    }
    @Test void histogramPreviewIsBoundedAndDoesNotBroadcastQueryEvents() {
        for (boolean legacy : List.of(false, true)) try (Run run = new Run(dump, legacy)) {
            JsonArray rows = run.instances("java.lang.String").getAsJsonArray("rows");
            assertEquals(200, rows.size(), "This fixture must exercise the preview cap");
            long previous = Long.MAX_VALUE;
            for (JsonElement value : rows) {
                JsonArray row = value.getAsJsonArray();
                assertEquals("java.lang.String", row.get(2).getAsString());
                long retained = row.get(4).getAsLong();
                assertTrue(retained <= previous); previous = retained;
            }
            assertTrue(run.events.stream().noneMatch(e -> Set.of("queryResult", "queryError")
                .contains(e.get("command").getAsString())), "Histogram must not update Query results/history");
            JsonArray expected = run.query("SELECT object_id, node_type, class_name, shallow_size, retained_size"
                + " FROM instances WHERE class_name = 'java.lang.String' ORDER BY retained_size DESC LIMIT 200")
                .getAsJsonArray("rows");
            assertEquals(expected, rows);
            assertTrue(run.instances("NoSuchHistogramClass").getAsJsonArray("rows").isEmpty());
        }
    }
    @Test void closingOneEditorDoesNotBreakSecondEditor() {
        try (Run first = new Run(dump, false); Run second = new Run(dump, false)) {
            assertNotEquals(first.session.pid(), second.session.pid());
            first.close();
            assertFalse(second.query("SELECT object_id FROM instances LIMIT 1").getAsJsonArray("rows").isEmpty());
        }
    }
    @Test void indexedAndLegacyAgreeOnQueryRows() {
        try (Run indexed = new Run(dump, false); Run legacy = new Run(dump, true)) {
            JsonObject a = indexed.analysis().getAsJsonObject("summary"), b = legacy.analysis().getAsJsonObject("summary");
            assertTrue(a.get("total_heap_size").getAsLong() > 0);
            for (String key : List.of("total_heap_size", "reachable_heap_size", "total_instances", "total_arrays", "total_gc_roots"))
                assertEquals(a.get(key), b.get(key), key);
            String query = Boolean.getBoolean("heaplens.test.ci")
                ? "SELECT object_id, shallow_size, retained_size FROM instances WHERE class_name LIKE '%ClassRetainedCounterexample$Cache' ORDER BY object_id"
                : "SELECT object_id, shallow_size, retained_size FROM instances ORDER BY object_id LIMIT 10";
            JsonArray rows = indexed.query(query).getAsJsonArray("rows");
            assertFalse(rows.isEmpty());
            if (Boolean.getBoolean("heaplens.test.ci")) assertEquals(3, rows.size());
            assertEquals(rows, legacy.query(query).get("rows"));
        }
    }
    @TestFactory @Tag("local-fixture") Stream<DynamicTest> sixLayoutFixturesMatchAcrossIndexedAndLegacy() {
        String root = System.getProperty("heaplens.test.matrix");
        if (root == null || binary == null) return Stream.of(DynamicTest.dynamicTest("matrix requires explicit inputs",
            () -> assumeTrue(false, "Supply heaplens.test.matrix directory")));
        Map<String, Long> totals = Map.of("default",1239216L,"mixed",1633760L,"uncompressed",980688L,
            "aligned16",726352L,"wide-klass",748072L,"jdk19",1182544L);
        return totals.entrySet().stream().sorted(Map.Entry.comparingByKey()).map(entry -> DynamicTest.dynamicTest(entry.getKey(), () -> {
            Path file = Path.of(root, "layout-" + entry.getKey() + ".hprof");
            assertTrue(Files.isRegularFile(file));
            long started = System.nanoTime();
            try (Run indexed = new Run(file, false); Run legacy = new Run(file, true)) {
                JsonObject a = indexed.analysis().getAsJsonObject("summary"), b = legacy.analysis().getAsJsonObject("summary");
                assertEquals(entry.getValue().longValue(), a.get("total_heap_size").getAsLong());
                for (String key : List.of("total_heap_size", "reachable_heap_size", "total_instances", "total_arrays", "total_gc_roots"))
                    assertEquals(a.get(key), b.get(key), entry.getKey() + ": " + key);
                String query = "SELECT object_id, shallow_size, retained_size FROM instances WHERE class_name LIKE '%ShallowSizeCounterexample%' ORDER BY object_id";
                assertEquals(indexed.query(query).get("rows"), legacy.query(query).get("rows"));
                System.out.printf("MATRIX %s indexed/legacy parity, total_heap=%d, elapsed_ms=%.1f%n",
                    entry.getKey(), entry.getValue(), (System.nanoTime()-started)/1e6);
            }
        }));
    }
}
