package com.heaplens.ai;

import com.google.gson.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ChatContextTest {
    @Test void allowlistOmitsValuesPathsDescriptionsSourceAndArbitraryFutureFields() {
        JsonObject analysis=JsonParser.parseString("""
            {"path":"SECRET_PATH","source":"SECRET_SOURCE","summary":{"total_heap_size":123,"path":"SECRET_PATH"},
             "topObjects":[{"class_name":"example.Owner","field_name":"buffer","retained_size":42,"primitive_value":"SECRET_VALUE","object_id":999}],
             "classHistogram":[{"class_name":"example.Owner","instance_count":4,"shallow_size":16,"retained_size":42,"preview":"SECRET_PREVIEW"}],
             "leakSuspects":[{"class_name":"example.Owner","retained_size":42,"retained_percentage":25,"description":"SECRET_DESCRIPTION"}],
             "wasteAnalysis":{"total_wasted_bytes":5,"duplicate_strings":[{"preview":"SECRET_STRING","count":3}]}}
            """).getAsJsonObject();
        String before=analysis.toString(),context=ChatContext.from(analysis);
        assertFalse(context.contains("SECRET"));
        assertEquals("999",JsonParser.parseString(context).getAsJsonObject().getAsJsonArray("topObjects").get(0).getAsJsonObject().get("object_id").getAsString());
        assertTrue(context.contains("example.Owner"));assertTrue(context.contains("buffer"));assertTrue(context.contains("123"));
        assertEquals(before,analysis.toString());
    }
    @Test void wideObjectIdentitiesAndEvidenceLimitsAreExactAndScoped() {
        JsonObject analysis=JsonParser.parseString("""
            {"summary":{"total_heap_size":2000,"reachable_heap_size":1500},
             "topObjects":[{"object_id":18446744073709551615,"class_name":"example.Owner","retained_size":1000}]}
            """).getAsJsonObject();
        JsonObject context=JsonParser.parseString(ChatContext.from(analysis)).getAsJsonObject();
        assertEquals("18446744073709551615",context.getAsJsonArray("topObjects").get(0).getAsJsonObject().get("object_id").getAsString());
        assertEquals(1500,context.getAsJsonObject("summary").get("reachable_heap_size").getAsInt());
        assertTrue(context.get("evidence_note").getAsString().contains("class-group"));
        assertEquals("not_calculated",context.get("waste_status").getAsString());
    }
    @Test void contextIsBoundedAndMalformedRawValuesCannotEnterNumericFields() {
        JsonObject analysis=new JsonObject();JsonArray rows=new JsonArray();
        for(int i=0;i<500;i++) {
            JsonObject row=new JsonObject();row.addProperty("class_name","X".repeat(1000));row.addProperty("retained_size","SECRET_NUMERIC");rows.add(row);
        }
        analysis.add("classHistogram",rows);analysis.add("topObjects",rows);analysis.add("leakSuspects",rows);
        String context=ChatContext.from(analysis);
        assertTrue(context.length()<30000);assertFalse(context.contains("SECRET"));
        JsonObject parsed=JsonParser.parseString(context).getAsJsonObject();
        assertEquals(20,parsed.getAsJsonArray("classHistogram").size());assertEquals(15,parsed.getAsJsonArray("topObjects").size());
        assertEquals(10,parsed.getAsJsonArray("leakSuspects").size());
    }
    @Test void suspectScopeRejectsNegativeFractionalAndOversizedIdentities() {
        JsonObject analysis=JsonParser.parseString("""
            {"leakSuspects":[{"object_id":0},{"object_id":42},{"object_id":-1},
             {"object_id":1.5},{"object_id":18446744073709551616}]}
            """).getAsJsonObject();
        JsonArray rows=JsonParser.parseString(ChatContext.from(analysis)).getAsJsonObject().getAsJsonArray("leakSuspects");
        assertEquals("class_group",rows.get(0).getAsJsonObject().get("scope").getAsString());
        assertEquals("object",rows.get(1).getAsJsonObject().get("scope").getAsString());
        for(int i=2;i<rows.size();i++)assertEquals("unknown",rows.get(i).getAsJsonObject().get("scope").getAsString());
    }
}
