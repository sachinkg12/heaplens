package com.heaplens.snapshots;

import com.google.gson.*;
import com.heaplens.session.*;
import java.util.*;
import java.util.function.BiConsumer;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class SnapshotActionsTest {
    static JsonObject data(int bytes){
        return JsonParser.parseString("{\"summary\":{\"total_heap_size\":"+bytes+"},\"classHistogram\":[{\"class_name\":\"example.A\",\"retained_size\":"+bytes+"}],\"leakSuspects\":[],\"wasteAnalysis\":{\"total_wasted_bytes\":5,\"duplicate_strings\":[{\"preview\":\"PRIVATE\"}]}}").getAsJsonObject();
    }
    static JsonObject request(String command){JsonObject r=new JsonObject();r.addProperty("command",command);r.addProperty("requestId","request-1");return r;}
    static final class Read implements AnalysisReadPort {
        String method;JsonObject params;BiConsumer<JsonElement,String> reply;
        public void read(String method,JsonObject params,BiConsumer<JsonElement,String> reply){this.method=method;this.params=params;this.reply=reply;}
    }
    @Test void snapshotsAreCopiesExcludeRawValuesAndCloseRemovesOnlyOwner(){
        var catalog=new SnapshotCatalog();var original=data(10);catalog.publish("a","first",1,original);original.getAsJsonObject("summary").addProperty("total_heap_size",999);
        catalog.publish("b","second",2,data(20));
        assertEquals(10,catalog.get("a").data().getAsJsonObject("summary").get("total_heap_size").getAsInt());
        assertFalse(catalog.get("a").data().toString().contains("PRIVATE"));
        try(var actions=new SnapshotActions(catalog,"a",new Read(),e->{})){}
        assertThrows(IllegalArgumentException.class,()->catalog.get("a"));assertEquals(1,catalog.list().size());
        assertTrue(new SnapshotCatalog().list().isEmpty());
    }
    @Test void comparisonDelegatesArithmeticToEngineAndIgnoresLateReplies(){
        var catalog=new SnapshotCatalog();catalog.publish("a","first",1,data(10));catalog.publish("b","second",2,data(20));
        var read=new Read();List<JsonObject> events=new ArrayList<>();
        try(var actions=new SnapshotActions(catalog,"b",read,events::add)){
            var router=actions.register(new CommandRouter(Map.of()));var req=request("compareHeaps");req.addProperty("baselinePath","a");
            assertTrue(router.dispatch(req.toString()));assertEquals("compare_snapshots",read.method);assertEquals("first",read.params.get("baseline_label").getAsString());
            read.reply.accept(new JsonObject(),null);assertEquals("compareResult",events.getLast().get("command").getAsString());
            router.dispatch(req.toString());catalog.remove("a");int n=events.size();read.reply.accept(new JsonObject(),null);assertEquals(n,events.size());
            req.addProperty("baselinePath","/private/arbitrary.hprof");router.dispatch(req.toString());assertEquals("compareError",events.getLast().get("command").getAsString());
        }
    }
    @Test void listUsesOpaqueIdsAndTimelineOrdersByMtimeAndRejectsInvalidSelections(){
        var catalog=new SnapshotCatalog();catalog.publish("a","late",2000,data(20));catalog.publish("b","early",1000,data(10));
        List<JsonObject> events=new ArrayList<>();
        try(var actions=new SnapshotActions(catalog,"a",new Read(),events::add)){
            var router=actions.register(new CommandRouter(Map.of()));router.dispatch(request("listAnalyzedFiles").toString());
            assertEquals("[\"b\"]",events.getLast().get("files").toString());assertEquals("early",events.getLast().getAsJsonObject("labels").get("b").getAsString());
            var req=request("getTimelineData");req.add("paths",JsonParser.parseString("[\"a\",\"b\"]"));router.dispatch(req.toString());
            var snapshots=events.getLast().getAsJsonObject("result").getAsJsonArray("snapshots");assertEquals("early",snapshots.get(0).getAsJsonObject().get("path").getAsString());
            req.add("paths",JsonParser.parseString("[\"a\",\"a\"]"));router.dispatch(req.toString());assertEquals("timelineError",events.getLast().get("command").getAsString());
        }
    }
    @Test void classFallingOutOfTopTenDoesNotBecomeZero(){
        var catalog=new SnapshotCatalog();var second=data(90);JsonArray rows=second.getAsJsonArray("classHistogram");JsonObject actual=rows.remove(0).getAsJsonObject();
        for(int i=0;i<10;i++){JsonObject entry=actual.deepCopy();entry.addProperty("class_name","larger."+i);rows.add(entry);}rows.add(actual);
        catalog.publish("a","first",1,data(100));catalog.publish("b","second",2,second);List<JsonObject> events=new ArrayList<>();
        try(var actions=new SnapshotActions(catalog,"a",new Read(),events::add)){
            var r=request("getTimelineData");r.add("paths",JsonParser.parseString("[\"a\",\"b\"]"));actions.register(new CommandRouter(Map.of())).dispatch(r.toString());
            var tracked=events.getLast().getAsJsonObject("result").getAsJsonArray("snapshots").get(1).getAsJsonObject().getAsJsonArray("top_classes");
            assertTrue(tracked.asList().stream().anyMatch(e->e.getAsJsonObject().get("class_name").getAsString().equals("example.A") && e.getAsJsonObject().get("retained_size").getAsInt()==90));
        }
    }
    @Test void catalogBoundsOpenSnapshots(){var catalog=new SnapshotCatalog();for(int i=0;i<16;i++)catalog.publish("id"+i,"dump",1,data(i));
        assertThrows(IllegalArgumentException.class,()->catalog.publish("17","dump",1,data(17)));catalog.remove("id0");catalog.publish("17","dump",1,data(17));assertEquals(16,catalog.list().size());}
}
