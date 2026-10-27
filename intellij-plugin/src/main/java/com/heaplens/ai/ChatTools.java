package com.heaplens.ai;

import com.google.gson.*;
import java.util.*;

/** Native function calls are transport data, never extracted from answer prose. */
final class ChatTools {
    private static final Gson STRICT=new GsonBuilder().setStrictness(Strictness.STRICT).create();
    private static int index(JsonObject object){String value=object.get("index").toString();if(!value.matches("[0-9]{1,2}"))throw new IllegalArgumentException("Tool index");return Integer.parseInt(value);}
    static boolean supported(AiConfiguration config){
        var p=AiProviders.get(config.settings().provider());
        return p.toolCalls() && config.settings().model().equals(p.defaultModel())
            && config.settings().baseUrl().equals(p.defaultBaseUrl().replaceAll("/+$",""));
    }
    static void tools(JsonObject body,boolean anthropic){
        JsonObject definition=InvestigationEvidence.CONTRACT.getAsJsonObject("tool").deepCopy();JsonArray tools=new JsonArray();
        if(anthropic){definition.add("input_schema",definition.remove("parameters"));tools.add(definition);}
        else{JsonObject tool=new JsonObject();tool.addProperty("type","function");tool.add("function",definition);tools.add(tool);body.addProperty("tool_choice","auto");}
        body.add("tools",tools);
    }
    static JsonObject message(LlmTransport.Message message,boolean anthropic){
        JsonObject row=new JsonObject();row.addProperty("role",message.role());
        if(message.role().equals("tool")){
            if(anthropic){row.addProperty("role","user");JsonObject result=new JsonObject();result.addProperty("type","tool_result");result.addProperty("tool_use_id",message.toolCallId());result.addProperty("content",message.content());JsonArray blocks=new JsonArray();blocks.add(result);row.add("content",blocks);}
            else{row.addProperty("tool_call_id",message.toolCallId());row.addProperty("content",message.content());}return row;
        }
        if(message.toolCalls()==null){row.addProperty("content",message.content());return row;}
        JsonArray calls=new JsonArray();
        for(var call:message.toolCalls()){
            JsonObject tool=new JsonObject();tool.addProperty("id",call.id());
            if(anthropic){tool.addProperty("type","tool_use");tool.addProperty("name",call.name());tool.add("input",JsonParser.parseString(call.arguments()));}
            else{tool.addProperty("type","function");JsonObject function=new JsonObject();function.addProperty("name",call.name());function.addProperty("arguments",call.arguments());tool.add("function",function);}calls.add(tool);
        }
        if(anthropic){if(!message.content().isEmpty()){JsonObject text=new JsonObject();text.addProperty("type","text");text.addProperty("text",message.content());calls.asList().add(0,text);}row.add("content",calls);}
        else{row.addProperty("content",message.content());row.add("tool_calls",calls);}return row;
    }
    private final Map<Integer,String[]> calls=new LinkedHashMap<>();
    void consume(JsonObject event,boolean anthropic){
        if(anthropic){String type=event.has("type")?event.get("type").getAsString():"";
            if(type.equals("content_block_start") && event.getAsJsonObject("content_block").get("type").getAsString().equals("tool_use")){
                JsonObject block=event.getAsJsonObject("content_block");JsonObject input=block.getAsJsonObject("input");add(index(event),text(block,"id"),text(block,"name"),input!=null&&!input.isEmpty()?input.toString():"");
            }else if(type.equals("content_block_delta") && "input_json_delta".equals(text(event.getAsJsonObject("delta"),"type")))add(index(event),"","",text(event.getAsJsonObject("delta"),"partial_json"));
        }else if(event.has("choices")&&!event.getAsJsonArray("choices").isEmpty()){
            JsonObject choice=event.getAsJsonArray("choices").get(0).getAsJsonObject(),delta=choice.has("delta")?choice.getAsJsonObject("delta"):new JsonObject();
            if(delta.has("tool_calls"))for(JsonElement item:delta.getAsJsonArray("tool_calls")){JsonObject c=item.getAsJsonObject(),f=c.has("function")?c.getAsJsonObject("function"):new JsonObject();if(c.has("type")&&!"function".equals(text(c,"type")))throw new IllegalArgumentException("Tool type");add(index(c),text(c,"id"),text(f,"name"),text(f,"arguments"));}
        }
    }
    private static String text(JsonObject object,String key){return object.has(key)?object.get(key).getAsString():"";}
    private void add(int index,String id,String name,String args){
        if(index<0||index>31||!calls.containsKey(index)&&calls.size()>=3)throw new IllegalArgumentException("Tool count");
        String[] call=calls.computeIfAbsent(index,k->new String[]{"","",""});call[0]+=id;call[1]+=name;call[2]+=args;
        if(call[0].length()>200||call[1].length()>80||call[2].length()>8192)throw new IllegalArgumentException("Tool size");
    }
    List<LlmTransport.ToolCall> finish(){
        List<LlmTransport.ToolCall> out=new ArrayList<>();Set<String> ids=new HashSet<>();
        for(String[] c:calls.values()){if(!c[0].matches("[A-Za-z0-9_-]{1,200}")||c[1].isEmpty()||!ids.add(c[0]))throw new IllegalArgumentException("Tool identity");if(STRICT.fromJson(c[2],JsonObject.class)==null)throw new IllegalArgumentException("Tool object required");out.add(new LlmTransport.ToolCall(c[0],c[1],c[2]));}return List.copyOf(out);
    }
}
