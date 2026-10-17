package com.heaplens.session;

import com.google.gson.JsonObject;
import java.util.Map;

/** Translation only: existing engine DTOs to the unchanged webview contract. */
public final class WebviewEvents {
    private WebviewEvents() { }
    public static JsonObject event(String command) {
        JsonObject value = new JsonObject(); value.addProperty("command", command); return value;
    }
    public static JsonObject error(String reason) {
        JsonObject value = event("serverCrashed"); value.addProperty("message", reason); return value;
    }
    public static JsonObject analysis(JsonObject result) {
        JsonObject value = event("analysisComplete");
        Map.of("summary", "summary", "top_objects", "topObjects", "top_layers", "topLayers",
            "class_histogram", "classHistogram", "leak_suspects", "leakSuspects",
            "object_leak_suspects", "objectLeakSuspects", "waste_analysis", "wasteAnalysis")
            .forEach((from, to) -> { if (result.has(from)) value.add(to, result.get(from)); });
        if(result.has("storage") && result.get("storage").isJsonObject())value.add("storage",result.get("storage"));
        return value;
    }
    public static JsonObject progress(JsonObject params) {
        JsonObject value = event("analysisProgress");
        Map.of("stage", "stage", "phase", "phase", "total_phases", "totalPhases")
            .forEach((from, to) -> { if (params.has(from)) value.add(to, params.get(from)); });
        if (params.has("summary") && params.get("summary").isJsonObject()) value.add("summary",params.get("summary"));
        if (params.has("snapshot") && params.get("snapshot").isJsonObject()) value.add("snapshot",params.get("snapshot"));
        if (params.has("file_metadata") && params.get("file_metadata").isJsonObject()) value.add("fileMetadata",params.get("file_metadata"));
        return value;
    }
    public static JsonObject scan(JsonObject result) {
        JsonObject value=event("shallowScanComplete");
        Map.of("summary","summary","class_histogram","classHistogram","readiness","readiness")
            .forEach((from,to)->{if(result.has(from))value.add(to,result.get(from));});
        return value;
    }
}
