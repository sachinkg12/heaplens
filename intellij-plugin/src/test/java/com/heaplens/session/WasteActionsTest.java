package com.heaplens.session;

import com.google.gson.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class WasteActionsTest {
    @Test void explicitActionUsesOnlyHostReadAndCorrelatesReplies() {
        List<JsonObject> replies=new ArrayList<>();
        var action=new WasteActions((method,params,reply)->{
            assertEquals("get_waste_analysis",method);assertTrue(params.isEmpty());
            reply.accept(JsonParser.parseString("{\"total_wasted_bytes\":0}"),null);
        },replies::add);
        var router=action.register(new CommandRouter(Map.of()));
        assertTrue(replies.isEmpty());
        assertTrue(router.dispatch("{\"command\":\"calculateWaste\",\"requestId\":\"waste-1\",\"path\":\"/untrusted\",\"method\":\"export_json\"}"));
        assertEquals("wasteResult",replies.getFirst().get("command").getAsString());
        assertEquals("waste-1",replies.getFirst().get("requestId").getAsString());
        assertEquals(0,replies.getFirst().getAsJsonObject("wasteAnalysis").get("total_wasted_bytes").getAsInt());
        assertFalse(router.dispatch("{\"command\":\"calculateWaste\",\"requestId\":\"invalid/id\"}"));
    }
    @Test void failedReadIsNotReportedAsZeroWaste() {
        List<JsonObject> replies=new ArrayList<>();
        var router=new WasteActions((m,p,r)->r.accept(null,"PRIVATE"),replies::add).register(new CommandRouter(Map.of()));
        router.dispatch("{\"command\":\"calculateWaste\",\"requestId\":\"waste-2\"}");
        assertEquals("wasteError",replies.getFirst().get("command").getAsString());
        assertFalse(replies.getFirst().has("wasteAnalysis"));
        assertFalse(replies.getFirst().toString().contains("PRIVATE"));
    }
}
