package com.heaplens.ai;

import com.google.gson.*;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Native implementation of the build-generated shared evidence contract, not a prompt-only verifier. */
final class InvestigationEvidence {
    static final JsonObject CONTRACT=JsonParser.parseString(AiProviders.resource("investigation-contract.json")).getAsJsonObject();
    static final Set<String> OPERATIONS=new HashSet<>();
    static {if(CONTRACT.get("schema_version").getAsInt()!=1)throw new IllegalStateException("Unsupported evidence contract");CONTRACT.getAsJsonArray("operations").forEach(v->OPERATIONS.add(v.getAsString()));}
    static int limit(String key){return CONTRACT.getAsJsonObject("limits").get(key).getAsInt();}
    private static final BigInteger MAX=new BigInteger("18446744073709551615");
    static String exact(JsonElement value,boolean positive){
        if(value==null || !value.isJsonPrimitive())throw new IllegalArgumentException("Exact identity/value required");
        String text=value.getAsString();
        if(!text.matches("0|[1-9][0-9]{0,19}") || new BigInteger(text).compareTo(MAX)>0 || positive && text.equals("0"))throw new IllegalArgumentException("Exact identity/value required");
        return text;
    }
    /** Page numbers have passed through JavaScript; wide IDs must arrive as strings. */
    static String pageId(JsonElement value){
        String id=exact(value,true);
        if(!value.getAsJsonPrimitive().isString() && new BigInteger(id).compareTo(BigInteger.valueOf(9007199254740991L))>0)throw new IllegalArgumentException("Wide object IDs must be strings");
        return id;
    }
    static String text(JsonObject o,String key){JsonElement v=o.get(key);if(v==null || !v.isJsonPrimitive() || !v.getAsJsonPrimitive().isString())throw new IllegalArgumentException("String required");return v.getAsString();}
    static void keys(JsonObject o,String...allowed){if(!Set.of(allowed).containsAll(o.keySet()))throw new IllegalArgumentException("Unsupported evidence field");}
    static JsonObject object(JsonElement value){if(value==null || !value.isJsonObject())throw new IllegalArgumentException("Object required");return value.getAsJsonObject();}
    static int bytes(JsonElement value){return value.toString().getBytes(StandardCharsets.UTF_8).length;}
    static String name(JsonElement value){String text=value!=null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()?value.getAsString():"";return text.substring(0,Math.min(text.length(),256));}
    static JsonObject descriptor(JsonObject v){
        JsonObject out=new JsonObject();for(String key:List.of("object_id","shallow_size","retained_size"))out.addProperty(key,exact(v.get(key),false));
        for(String key:List.of("class_name","node_type")){String label=text(v,key);if(label.length()>1024)throw new IllegalArgumentException("Name too long");out.addProperty(key,label);}
        out.addProperty("name_truncated",v.has("name_truncated") && v.get("name_truncated").getAsBoolean());return out;
    }
    static JsonObject seed(JsonObject data,JsonObject selectedGroup){
        JsonObject out=new JsonObject(),summary=new JsonObject();JsonObject source=data.has("summary")?object(data.get("summary")):new JsonObject();
        for(String key:List.of("total_heap_size","reachable_heap_size","total_instances","total_classes","total_arrays","total_gc_roots"))try{summary.addProperty(key,exact(source.get(key),false));}catch(IllegalArgumentException ignored){}
        out.add("summary",summary);JsonArray rows=new JsonArray(),groups=new JsonArray();
        JsonArray top=data.has("topObjects") && data.get("topObjects").isJsonArray()?data.getAsJsonArray("topObjects"):new JsonArray();
        for(int i=0;i<Math.min(top.size(),15);i++)try{
            JsonObject raw=object(top.get(i)).deepCopy();String label=text(raw,"class_name");raw.addProperty("class_name",name(raw.get("class_name")));raw.addProperty("name_truncated",label.length()>256);rows.add(descriptor(raw));
        }catch(IllegalArgumentException ignored){}
        JsonArray classes=new JsonArray();if(selectedGroup!=null)classes.add(selectedGroup);else if(data.has("classHistogram") && data.get("classHistogram").isJsonArray())classes=data.getAsJsonArray("classHistogram");
        for(int i=0;i<Math.min(classes.size(),20);i++)try{
            JsonObject raw=object(classes.get(i)),row=new JsonObject();row.addProperty("class_name",name(raw.get("class_name")));row.addProperty("name_truncated",text(raw,"class_name").length()>256);
            for(String key:List.of("instance_count","shallow_size","retained_size"))row.addProperty(key,exact(raw.get(key),false));groups.add(row);
        }catch(IllegalArgumentException ignored){}
        out.add("rows",rows);out.add("classes",groups);out.addProperty("status","complete");out.addProperty("truncated",top.size()>15 || classes.size()>20);
        out.addProperty("note","Bounded analysis metadata, bytes unless specified. JVM sizing estimates apply; nested retained sets and class totals overlap. Not allocation history or proof of a leak.");return out;
    }
    static JsonObject project(JsonObject raw,JsonObject action){
        String op=text(action,"operation");if(!raw.has("schema_version") || raw.get("schema_version").getAsInt()!=1 || !op.equals(text(raw,"operation")))throw new IllegalArgumentException("Unsupported evidence contract");
        JsonObject selected=descriptor(object(raw.get("selected")));
        if(!text(selected,"object_id").equals(text(action,"object_id")))throw new IllegalArgumentException("Wrong selected object");
        String status=text(raw,"status");if(!Set.of("complete","found","no_path_found","unavailable","budget_exhausted").contains(status))throw new IllegalArgumentException("Invalid evidence status");
        if(!raw.has("truncated") || !raw.get("truncated").isJsonPrimitive() || !raw.get("truncated").getAsJsonPrimitive().isBoolean())throw new IllegalArgumentException("Invalid truncation");
        JsonArray source=raw.getAsJsonArray("rows");if(source==null || source.size()>33)throw new IllegalArgumentException("Evidence row limit");
        JsonArray rows=new JsonArray();for(JsonElement value:source){JsonObject row=object(value);if(op.equals("fields")){JsonObject field=new JsonObject();for(String key:List.of("name","field_type")){String label=text(row,key);if(label.length()>1024)throw new IllegalArgumentException("Name too long");field.addProperty(key,label);}field.addProperty("name_truncated",row.has("name_truncated")&&row.get("name_truncated").getAsBoolean());rows.add(field);}else rows.add(descriptor(row));}
        JsonObject out=new JsonObject();out.add("selected",selected);out.add("rows",rows);out.addProperty("status",status);out.add("truncated",raw.get("truncated"));if(raw.has("total"))out.addProperty("total",exact(raw.get("total"),false));
        out.addProperty("note","Engine metadata, not a verified leak or repair. Nested retained sizes overlap. Prefixes are not ranked. No returned path does not prove unreachable.");
        if(bytes(out)>limit("evidenceBytes"))throw new IllegalArgumentException("Evidence output limit");return out;
    }
    final String scope;
    private final String prefix=UUID.randomUUID().toString().replace("-","").substring(0,12);
    private final Map<String,JsonObject> records=new LinkedHashMap<>();
    private final Set<String> known=new HashSet<>();
    InvestigationEvidence(String scope){this.scope=scope;}
    synchronized JsonObject add(String op,JsonObject data){
        if(records.size()>=limit("records") || bytes(data)>limit("evidenceBytes"))throw new IllegalArgumentException("Evidence session limit. Clear AI to restart.");
        JsonObject record=new JsonObject();record.addProperty("id","E"+prefix+"_"+(records.size()+1));record.addProperty("scope",scope);record.addProperty("operation",op);record.add("data",data.deepCopy());records.put(text(record,"id"),record);
        if(data.has("selected"))discover(data.get("selected"));if(data.has("rows"))data.getAsJsonArray("rows").forEach(this::discover);return record.deepCopy();
    }
    private void discover(JsonElement raw){try{String id=exact(object(raw).get("object_id"),true);if(known.size()<4096)known.add(id);}catch(IllegalArgumentException ignored){}}
    synchronized JsonObject get(String id){JsonObject value=records.get(id);if(value==null)throw new IllegalArgumentException("Evidence expired or unavailable");return value.deepCopy();}
    synchronized JsonObject action(JsonObject response){
        keys(response,"action","tool","object_id");String op=text(response,"tool"),id=text(response,"object_id");exact(response.get("object_id"),true);
        if(!"read".equals(text(response,"action")) || !OPERATIONS.contains(op) || !known.contains(id))throw new IllegalArgumentException("Unapproved read or object identity");
        JsonObject out=new JsonObject();out.addProperty("operation",op);out.addProperty("object_id",id);return out;
    }
    /** Host-rendered existing metadata, never an invented model answer or another read. */
    synchronized JsonObject budgetSummary(JsonObject summary,String selected,Set<String> referenced){
        JsonObject answer=new JsonObject();answer.addProperty("action","answer");JsonArray facts=new JsonArray();
        JsonObject data=object(summary.get("data"));
        if(data.has("truncated") && data.get("truncated").getAsBoolean())summaryFact(facts,summary,"truncated");
        for(String key:List.of("total_heap_size","reachable_heap_size","total_instances","total_classes","total_arrays","total_gc_roots"))summaryFact(facts,summary,"summary."+key);
        JsonObject chosen=null;
        if(selected!=null)for(String id:referenced){JsonObject record=get(id),value=object(record.get("data"));if(value.has("selected") && selected.equals(text(object(value.get("selected")),"object_id"))){chosen=record;break;}}
        if(chosen!=null)for(String key:List.of("object_id","class_name","retained_size"))summaryFact(facts,chosen,"selected."+key);
        else for(String key:List.of("object_id","class_name","retained_size"))summaryFact(facts,summary,"rows.0."+key);
        answer.add("facts",facts);answer.add("hypotheses",new JsonArray());JsonArray checks=new JsonArray();
        checks.add("The investigation reached its read/call budget. This summary contains existing metadata only; no additional reads, retries or AI diagnosis were completed.");answer.add("next_checks",checks);return answer;
    }
    private static void summaryFact(JsonArray facts,JsonObject record,String field){
        if(facts.size()>=limit("facts"))return;
        JsonElement value=record.get("data");
        for(String part:field.split("\\.")){
            if(value!=null && value.isJsonObject())value=value.getAsJsonObject().get(part);
            else if(value!=null && value.isJsonArray() && part.matches("[0-9]+") && Integer.parseInt(part)<value.getAsJsonArray().size())value=value.getAsJsonArray().get(Integer.parseInt(part));
            else return;
        }
        if(value==null || !value.isJsonPrimitive())return;
        JsonObject fact=new JsonObject();fact.add("evidence_id",record.get("id"));fact.addProperty("field",field);facts.add(fact);
    }
    synchronized String answer(JsonObject response,Set<String> referenced){
        keys(response,"action","facts","hypotheses","next_checks");if(!"answer".equals(text(response,"action")))throw new IllegalArgumentException("Answer required");
        JsonArray facts=response.getAsJsonArray("facts"),hypotheses=response.getAsJsonArray("hypotheses"),checks=response.getAsJsonArray("next_checks");
        if(facts==null || hypotheses==null || checks==null || facts.size()>limit("facts") || hypotheses.size()>limit("hypotheses") || checks.size()>limit("checks") || facts.size()+hypotheses.size()+checks.size()==0)throw new IllegalArgumentException("Invalid bounded answer");
        StringBuilder out=new StringBuilder("Observed metadata (values rendered by HeapLens, not authored by the model):\n");
        String fields="(object_id|class_name|node_type|shallow_size|retained_size)";
        for(JsonElement raw:facts){JsonObject f=object(raw);keys(f,"evidence_id","field");String id=text(f,"evidence_id"),field=text(f,"field");
            if(!field.matches("selected\\."+fields+"|rows\\.[0-9]{1,2}\\.(object_id|class_name|node_type|shallow_size|retained_size|name|field_type)|classes\\.[0-9]{1,2}\\.(class_name|instance_count|shallow_size|retained_size)|summary\\.(total_heap_size|reachable_heap_size|total_instances|total_classes|total_arrays|total_gc_roots)|status|truncated|total"))throw new IllegalArgumentException("Unsupported fact field");
            JsonElement at=get(id).get("data"),parent=at;for(String part:field.split("\\.")){parent=at;at=at!=null && at.isJsonArray()?at.getAsJsonArray().get(Integer.parseInt(part)):object(at).get(part);}
            if(at==null || !at.isJsonPrimitive())throw new IllegalArgumentException("Unavailable fact");boolean clipped=field.endsWith("name") && parent.isJsonObject() && parent.getAsJsonObject().has("name_truncated") && parent.getAsJsonObject().get("name_truncated").getAsBoolean();
            out.append(field).append(": ").append(at.getAsString()).append(clipped?" [name truncated]":"").append(" [").append(id).append("]\n");referenced.add(id);
        }
        out.append("\nPossible explanations (not verified causes or repairs):\n");
        for(JsonElement raw:hypotheses){JsonObject h=object(raw);keys(h,"text","evidence_ids");String label=text(h,"text");JsonArray ids=h.getAsJsonArray("evidence_ids");if(label.isBlank() || label.length()>800 || ids==null || ids.size()>4)throw new IllegalArgumentException("Invalid hypothesis");List<String> labels=new ArrayList<>();for(JsonElement value:ids){if(!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString())throw new IllegalArgumentException("Invalid evidence ID");String id=value.getAsString();get(id);referenced.add(id);labels.add(id);}out.append(label).append(labels.isEmpty()?"":" ["+String.join(", ",labels)+"]").append('\n');}
        out.append("\nNext checks (suggestions only; not executed):\n");for(JsonElement raw:checks){if(!raw.isJsonPrimitive() || !raw.getAsJsonPrimitive().isString() || raw.getAsString().isBlank() || raw.getAsString().length()>500)throw new IllegalArgumentException("Invalid next check");out.append(raw.getAsString()).append('\n');}return out.toString();
    }
}
