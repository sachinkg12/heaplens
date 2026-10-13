package com.heaplens.snapshots;

import com.google.gson.*;
import java.util.*;

/** Project-scoped, compact metadata only. Closing/retrying an editor retires its snapshot. */
public final class SnapshotCatalog {
    public record Snapshot(String id,String label,long timestamp,long revision,JsonObject data) { }
    private final Map<String,Snapshot> entries=new LinkedHashMap<>();
    private final Map<String,Runnable> listeners=new LinkedHashMap<>();
    private long revision;
    public synchronized void listen(String owner,Runnable listener){listeners.put(owner,listener);}
    public synchronized void unlisten(String owner){listeners.remove(owner);}
    public void publish(String id,String label,long timestamp,JsonObject analysis){
        JsonObject data=new JsonObject();
        for(var field:Map.of("summary","summary","classHistogram","class_histogram","leakSuspects","leak_suspects").entrySet()) {
            if(!analysis.has(field.getKey()))throw new IllegalArgumentException("Snapshot metadata is incomplete");
            data.add(field.getValue(),analysis.get(field.getKey()).deepCopy());
        }
        JsonElement value=analysis.get("wasteAnalysis");
        JsonObject raw=value!=null && value.isJsonObject()?value.getAsJsonObject():null;
        JsonObject waste=new JsonObject();
        for(String key:List.of("total_wasted_bytes","waste_percentage","duplicate_string_wasted_bytes",
            "empty_collection_wasted_bytes","over_allocated_wasted_bytes","boxed_primitive_wasted_bytes"))
            if(raw!=null && raw.has(key))waste.add(key,raw.get(key).deepCopy());
        data.add("waste_analysis",raw==null?JsonNull.INSTANCE:waste);
        if(data.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length>8*1024*1024)
            throw new IllegalArgumentException("Snapshot metadata exceeds the 8 MB limit");
        synchronized(this){
            if(!entries.containsKey(id) && entries.size()>=16)throw new IllegalArgumentException("Close another dump before adding more comparison snapshots");
            entries.put(id,new Snapshot(id,label,timestamp,++revision,data));
        }
        changed();
    }
    public void remove(String id){boolean removed; synchronized(this){removed=entries.remove(id)!=null;}if(removed)changed();}
    public void updateWaste(String id,JsonObject result) {
        synchronized(this) {
            Snapshot before=entries.get(id);if(before==null)return;
            JsonObject data=before.data().deepCopy(),totals=new JsonObject();
            for(String key:List.of("total_wasted_bytes","waste_percentage","duplicate_string_wasted_bytes",
                "empty_collection_wasted_bytes","over_allocated_wasted_bytes","boxed_primitive_wasted_bytes"))
                if(result.has(key))totals.add(key,result.get(key).deepCopy());
            data.add("waste_analysis",totals);
            entries.put(id,new Snapshot(id,before.label(),before.timestamp(),++revision,data));
        }
        changed();
    }
    public synchronized List<Snapshot> list(){return List.copyOf(entries.values());}
    public synchronized Snapshot get(String id){Snapshot s=entries.get(id);if(s==null)throw new IllegalArgumentException("Selected dump was closed or is being reanalyzed");return s;}
    public synchronized boolean contains(Snapshot s){return entries.get(s.id())==s;}
    private void changed(){List<Runnable> copy;synchronized(this){copy=List.copyOf(listeners.values());}for(Runnable r:copy)r.run();}
}
