package com.heaplens.ai;

import com.google.gson.*;

/** Host-owned allowlist. Never serialize an entire engine result or accept context from the page. */
public final class ChatContext {
    private ChatContext() { }
    public static JsonObject objectDetails(JsonObject info,JsonArray fieldValues,JsonArray path) {
        JsonObject out=new JsonObject();
        if(info.has("rows") && info.get("rows").isJsonArray() && !info.getAsJsonArray("rows").isEmpty()
            && info.getAsJsonArray("rows").get(0).isJsonArray()) {
            JsonArray row=info.getAsJsonArray("rows").get(0).getAsJsonArray();
            JsonObject object=new JsonObject();
            if(row.size()==3){object.add("class_name",row.get(0));object.add("shallow_size",row.get(1));object.add("retained_size",row.get(2));}
            out.add("object",fields(object,new String[]{"shallow_size","retained_size"},new String[]{"class_name"}));
        }
        JsonArray safeFields=new JsonArray();
        for(int i=0;i<Math.min(fieldValues.size(),100);i++) {
            JsonObject raw=object(fieldValues.get(i));
            JsonObject safe=fields(raw,new String[]{},new String[]{"name","field_type"});
            safe.add("reference",fields(object(raw.get("ref_summary")),new String[]{"retained_size","shallow_size"},new String[]{"class_name"}));
            safeFields.add(safe);
        }
        out.add("fields",safeFields);
        JsonArray safePath=new JsonArray();
        for(int i=0;i<Math.min(path.size(),100);i++) safePath.add(fields(object(path.get(i)),new String[]{},new String[]{"class_name","field_name","node_type"}));
        out.add("gc_root_path",safePath);return out;
    }
    public static String from(JsonObject analysis) {
        JsonObject out = new JsonObject();
        out.add("summary", fields(object(analysis.get("summary")),
            new String[]{"total_heap_size","reachable_heap_size","total_instances","total_classes","total_arrays","total_gc_roots"}, new String[]{}));
        out.addProperty("size_note", "Byte sizes may be JVM layout estimates. Nested retained sizes and class totals overlap; do not sum them.");
        rows(out,analysis,"topObjects",15,new String[]{"shallow_size","retained_size"},new String[]{"class_name","node_type","field_name"});
        rows(out,analysis,"classHistogram",20,new String[]{"instance_count","shallow_size","retained_size"},new String[]{"class_name"});
        rows(out,analysis,"leakSuspects",10,new String[]{"retained_size","retained_percentage"},new String[]{"class_name"});
        out.add("wasteTotals",fields(object(analysis.get("wasteAnalysis")),
            new String[]{"total_wasted_bytes","waste_percentage","duplicate_string_wasted_bytes","empty_collection_wasted_bytes"},new String[]{}));
        return out.toString();
    }
    private static JsonObject object(JsonElement value) { return value != null && value.isJsonObject() ? value.getAsJsonObject() : new JsonObject(); }
    private static JsonObject fields(JsonObject input,String[] numbers,String[] names) {
        JsonObject out = new JsonObject();
        for (String key:numbers) {
            JsonElement value=input.get(key);
            if(value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isNumber()
                && Double.isFinite(value.getAsDouble()) && value.getAsDouble() >= 0) out.add(key,value.deepCopy());
        }
        for (String key:names) {
            JsonElement value=input.get(key);
            if(value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()) {
                String name=value.getAsString();
                out.addProperty(key,name.substring(0,Math.min(name.length(),512)));
            }
        }
        return out;
    }
    private static void rows(JsonObject out,JsonObject input,String key,int limit,String[] numbers,String[] names) {
        JsonArray result=new JsonArray(); JsonElement values=input.get(key);
        if(values != null && values.isJsonArray()) {
            JsonArray array=values.getAsJsonArray();
            for(int i=0;i<Math.min(limit,array.size());i++) result.add(fields(object(array.get(i)),numbers,names));
        }
        out.add(key,result);
    }
}
