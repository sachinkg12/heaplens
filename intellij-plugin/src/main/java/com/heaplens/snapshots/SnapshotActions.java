package com.heaplens.snapshots;

import com.google.gson.*;
import com.heaplens.session.*;
import java.util.*;
import java.util.function.Consumer;

/** Coordinates immutable snapshots; comparison arithmetic remains in the Rust engine. */
public final class SnapshotActions implements AutoCloseable {
    private final SnapshotCatalog catalog;
    private final String owner;
    private final AnalysisReadPort analysis;
    private final Consumer<JsonObject> output;
    private volatile boolean closed;
    private long generation;
    public SnapshotActions(SnapshotCatalog catalog,String owner,AnalysisReadPort analysis,Consumer<JsonObject> output){
        this.catalog=catalog;this.owner=owner;this.analysis=analysis;this.output=output;
        catalog.listen(owner,()->{synchronized(this){generation++;if(!closed)output.accept(WebviewEvents.event("snapshotsChanged"));}});
    }
    public CommandRouter register(CommandRouter router){return router.with("listAnalyzedFiles",m->list(false))
        .with("listAllAnalyzedFiles",m->list(true)).with("compareHeaps",this::compare).with("getTimelineData",this::timeline);}
    private synchronized void list(boolean all){
        if(closed)return;JsonObject event=WebviewEvents.event(all?"allAnalyzedFiles":"analyzedFiles");JsonArray files=new JsonArray();
        for(var snapshot:catalog.list())if(all || !snapshot.id().equals(owner))files.add(snapshot.id());
        event.add("files",files);JsonObject labels=new JsonObject();for(var s:catalog.list())labels.addProperty(s.id(),s.label());
        event.add("labels",labels);output.accept(event);
    }
    private synchronized void compare(JsonObject message){
        String id=ObjectActions.requestId(message);long current=generation;
        try {
            var baseline=catalog.get(message.get("baselinePath").getAsString());var selected=catalog.get(owner);
            if(baseline==selected)throw new IllegalArgumentException("Choose a different baseline dump");
            JsonObject params=new JsonObject();params.add("baseline",baseline.data());params.add("current",selected.data());
            params.addProperty("baseline_label",baseline.label());params.addProperty("current_label",selected.label());
            analysis.read("compare_snapshots",params,(result,error)->{synchronized(this){
                if(closed || current!=generation)return;
                if(!catalog.contains(baseline) || !catalog.contains(selected)){error("compareError",id,"A selected dump changed. Compare again.");return;}
                if(error!=null || result==null || !result.isJsonObject()){
                    error("compareError",id,"Comparison failed. Use the bundled 0.1.6 server and reselect analyzed dumps.");return;}
                JsonObject event=WebviewEvents.event("compareResult");event.addProperty("requestId",id);event.add("result",result);output.accept(event);
            }});
        }catch(RuntimeException invalid){error("compareError",id,"Select two currently analyzed dumps in this project.");}
    }
    private synchronized void timeline(JsonObject message){
        String id=ObjectActions.requestId(message);
        try {
            JsonArray paths=message.getAsJsonArray("paths");if(paths.size()<2 || paths.size()>16)throw new IllegalArgumentException();
            Set<String> seen=new HashSet<>();List<SnapshotCatalog.Snapshot> selected=new ArrayList<>();
            for(JsonElement path:paths){String key=path.getAsString();if(!seen.add(key))throw new IllegalArgumentException();selected.add(catalog.get(key));}
            selected.sort(Comparator.comparingLong(SnapshotCatalog.Snapshot::timestamp).thenComparing(SnapshotCatalog.Snapshot::label));
            // Track a union of candidate classes, then look up each in the full histogram.
            // Falling out of the top ten must not be mistaken for dropping to zero.
            Set<String> tracked=new HashSet<>();
            for(var snapshot:selected){JsonArray rows=snapshot.data().getAsJsonArray("class_histogram");
                for(int i=0;i<Math.min(10,rows.size());i++)tracked.add(rows.get(i).getAsJsonObject().get("class_name").getAsString());}
            JsonArray snapshots=new JsonArray();
            for(var snapshot:selected){
                JsonObject row=new JsonObject();row.addProperty("path",snapshot.label());row.addProperty("timestamp",snapshot.timestamp()/1000);
                row.add("summary",snapshot.data().get("summary"));
                JsonArray classes=new JsonArray();JsonArray histogram=snapshot.data().getAsJsonArray("class_histogram");
                for(JsonElement entry:histogram)if(tracked.contains(entry.getAsJsonObject().get("class_name").getAsString()))classes.add(entry);
                row.add("top_classes",classes);snapshots.add(row);
            }
            JsonObject result=new JsonObject();result.add("snapshots",snapshots);
            JsonObject event=WebviewEvents.event("timelineDataResponse");event.addProperty("requestId",id);event.add("result",result);output.accept(event);
        }catch(RuntimeException invalid){error("timelineError",id,"Select 2–16 distinct analyzed dumps from this project. Closed/reanalyzing dumps are unavailable.");}
    }
    private void error(String command,String id,String message){if(closed)return;JsonObject event=WebviewEvents.event(command);event.addProperty("requestId",id);event.addProperty("error",message);output.accept(event);}
    @Override public void close(){synchronized(this){closed=true;generation++;}catalog.unlisten(owner);catalog.remove(owner);}
}
