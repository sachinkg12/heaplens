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
        assertFalse(context.contains("SECRET"));assertFalse(context.contains("999"));
        assertTrue(context.contains("example.Owner"));assertTrue(context.contains("buffer"));assertTrue(context.contains("123"));
        assertEquals(before,analysis.toString());
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
}
