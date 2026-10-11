package com.heaplens.telemetry;

import com.google.gson.*;
import java.util.*;

/** Explicit projection, never a copy of an analyzer result or user-controlled property bag. */
public final class TelemetryMetrics {
    private TelemetryMetrics(){}
    public static Map<String,Double> completion(JsonObject result,double duration) {
        Map<String,Double> values=new HashMap<>();values.put("durationMs",duration);
        JsonElement summary=result.get("summary");
        if(summary!=null && summary.isJsonObject()) {
            var s=summary.getAsJsonObject();number(s,"total_instances","objectCount",1,values);number(s,"total_classes","classCount",1,values);
            number(s,"total_heap_size","heapSizeMB",1048576,values);
        }
        return values;
    }
    private static void number(JsonObject source,String from,String to,double divisor,Map<String,Double> output) {
        JsonElement item=source.get(from);
        if(item!=null && item.isJsonPrimitive() && item.getAsJsonPrimitive().isNumber())output.put(to,item.getAsDouble()/divisor);
    }
}
