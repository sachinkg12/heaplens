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
        JsonArray children(long objectId) {
            List<JsonObject> replies = new CopyOnWriteArrayList<>();
            new DominatorQueries(session::read, replies::add).children(DominatorQueriesTest.request(objectId, "real-tree"));
            until(() -> !replies.isEmpty());
            JsonObject reply = replies.getFirst();
            assertEquals("dominatorChildrenResult", reply.get("command").getAsString(), reply.toString());
            assertEquals(objectId, reply.get("objectId").getAsLong());
            return reply.getAsJsonArray("children");
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
            long entry = run.analysis().getAsJsonArray("topLayers").get(0).getAsJsonObject().get("object_id").getAsLong();
            JsonArray beforeChildren = run.children(entry);
            long original = run.session.pid();
            assertTrue(ProcessHandle.of(original).orElseThrow().destroyForcibly()); // Only this test-owned child.
            until(() -> run.session.state() == HeapSession.State.FAILED);
            run.session.retry();
            until(() -> run.session.pid() != original);
            run.ready(); assertNotEquals(original, run.session.pid());
            assertEquals(before, run.analysis().getAsJsonObject("summary"));
            assertFalse(run.query("SELECT class_name, retained_size FROM class_histogram ORDER BY retained_size DESC LIMIT 3").getAsJsonArray("rows").isEmpty());
            assertFalse(run.instances("java.lang.String").getAsJsonArray("rows").isEmpty());
            assertEquals(beforeChildren, run.children(entry));
        }
    }
    @Test void comparisonSnapshotProtocolMatchesExistingEngineForSameRealDump()throws Exception {
        try(Run run=new Run(dump,false)){
            var catalog=new com.heaplens.snapshots.SnapshotCatalog();catalog.publish("a","before",1,run.analysis());
            var data=catalog.get("a").data();JsonObject params=new JsonObject();params.add("baseline",data);params.add("current",data);
            params.addProperty("baseline_label",dump.toString());params.addProperty("current_label",dump.toString());
            var compact=new CompletableFuture<JsonElement>();run.session.read("compare_snapshots",params,(v,e)->{if(e!=null)compact.completeExceptionally(new AssertionError(e));else compact.complete(v);});
            JsonObject paths=new JsonObject();paths.addProperty("baseline_path",dump.toString());paths.addProperty("current_path",dump.toString());
            var original=new CompletableFuture<JsonElement>();run.session.read("compare_heaps",paths,(v,e)->{if(e!=null)original.completeExceptionally(new AssertionError(e));else original.complete(v);});
            JsonObject first=compact.get(10,TimeUnit.SECONDS).getAsJsonObject(),second=original.get(10,TimeUnit.SECONDS).getAsJsonObject();
            assertComparisonParity(second.get("summary_delta"),first.get("summary_delta"),"summary");
            assertComparisonParity(second.get("waste_delta"),first.get("waste_delta"),"waste");
            for(String key:List.of("histogram_delta","leak_suspect_changes")){
                var left=new TreeMap<String,JsonElement>();var right=new TreeMap<String,JsonElement>();
                for(JsonElement row:first.getAsJsonArray(key))left.put(row.getAsJsonObject().get("class_name").getAsString(),row);
                for(JsonElement row:second.getAsJsonArray(key))right.put(row.getAsJsonObject().get("class_name").getAsString(),row);
                assertEquals(right.keySet(),left.keySet());for(String name:right.keySet())assertComparisonParity(right.get(name),left.get(name),name);
            }
        }
    }
    private static void assertComparisonParity(JsonElement expected,JsonElement actual,String key){
        if(expected.isJsonObject()){
            assertTrue(actual.isJsonObject());assertEquals(expected.getAsJsonObject().keySet(),actual.getAsJsonObject().keySet());
            for(var entry:expected.getAsJsonObject().entrySet())assertComparisonParity(entry.getValue(),actual.getAsJsonObject().get(entry.getKey()),entry.getKey());
        }else if(key.contains("percentage")){
            // JSON serialization/deserialization can round the final binary float digit.
            // Counts and byte sizes below still require exact equality.
            assertEquals(expected.getAsDouble(),actual.getAsDouble(),1e-12,key);
        }else assertEquals(expected,actual,key);
    }
    @Test void dominatorChildrenMatchTheirHeapqlSizesOnBothBackends() {
        for (boolean legacy : List.of(false, true)) try (Run run = new Run(dump, legacy)) {
            int checked = 0;
            for (JsonElement value : run.analysis().getAsJsonArray("topLayers")) {
                JsonObject parent = value.getAsJsonObject();
                if (!Set.of("Instance", "Array").contains(parent.get("node_type").getAsString())) continue;
                JsonArray children = run.children(parent.get("object_id").getAsLong());
                for (JsonElement child : children) {
                    JsonObject node = child.getAsJsonObject();
                    if (!Set.of("Instance", "Array").contains(node.get("node_type").getAsString())) continue;
                    JsonArray rows = run.query("SELECT shallow_size, retained_size FROM instances WHERE object_id = "
                        + node.get("object_id").getAsLong()).getAsJsonArray("rows");
                    assertEquals(1, rows.size());
                    assertEquals(node.get("shallow_size"), rows.get(0).getAsJsonArray().get(0));
                    assertEquals(node.get("retained_size"), rows.get(0).getAsJsonArray().get(1));
                    assertTrue(node.get("retained_size").getAsLong() <= parent.get("retained_size").getAsLong());
                    if (++checked >= 8) break;
                }
                if (checked >= 8) break;
            }
            assertTrue(checked > 0, "Fixture must exercise an expandable dominator");
            assertTrue(run.children(9007199254740991L).isEmpty());
        }
    }
    @Test void objectActionsUseTheRealEngineOnBothBackends() {
        for(boolean legacy:List.of(false,true))try(Run run=new Run(dump,legacy)){
            long id=run.query("SELECT object_id FROM instances WHERE class_name = 'java.lang.String' LIMIT 1")
                .getAsJsonArray("rows").get(0).getAsJsonArray().get(0).getAsLong();
            for(String command:List.of("inspectObject","gcRootPath","getReferrers","getDominatorSubtree")){
                List<JsonObject> replies=new CopyOnWriteArrayList<>();
                JsonObject request=ObjectActionsTest.request(command,command.equals("getDominatorSubtree")?0:id);
                new ObjectActions(run.session::read,replies::add).handle(request);until(()->!replies.isEmpty());
                JsonObject reply=replies.getFirst();assertFalse(reply.has("error"),reply.toString());
                if(command.equals("inspectObject"))assertFalse(reply.getAsJsonArray("fields").isEmpty());
                if(command.equals("getDominatorSubtree"))assertTrue(reply.getAsJsonObject("subtree").get("retained_size").getAsLong()>0);
            }
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
