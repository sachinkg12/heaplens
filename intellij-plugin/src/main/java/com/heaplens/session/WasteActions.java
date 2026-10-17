package com.heaplens.session;

import com.google.gson.*;
import java.util.function.Consumer;

/** On-demand content read through the existing generation-fenced analysis port. */
public final class WasteActions {
    private final AnalysisReadPort analysis;
    private final Consumer<JsonObject> output;
    public WasteActions(AnalysisReadPort analysis, Consumer<JsonObject> output) {
        this.analysis=analysis; this.output=output;
    }
    public CommandRouter register(CommandRouter router) {
        return router.with("calculateWaste", this::calculate);
    }
    private void calculate(JsonObject message) {
        String id=ObjectActions.requestId(message);
        analysis.read("get_waste_analysis",new JsonObject(),(result,error)->{
            boolean valid=error==null && result!=null && result.isJsonObject();
            JsonObject event=WebviewEvents.event(valid?"wasteResult":"wasteError");
            event.addProperty("requestId",id);
            if(valid)event.add("wasteAnalysis",result);
            else event.addProperty("error","Waste analysis unavailable. Retry after retained analysis completes.");
            output.accept(event);
        });
    }
}
