package com.heaplens.ai;

import com.google.gson.*;
import java.util.regex.Pattern;

/** Native evaluator of the generated shared rules, not an independent topic classifier. */
final class ChatInput {
    record Result(boolean safe,String text,String reason) { }
    private static final JsonObject POLICY=InvestigationEvidence.CONTRACT.getAsJsonObject("input_policy");
    private static String message(String key){return POLICY.getAsJsonObject("messages").get(key).getAsString();}
    static Result screen(String raw){
        if(raw==null)return new Result(false,null,message("invalid"));
        if(raw.length()>POLICY.get("maxChars").getAsInt())return new Result(false,null,message("oversized"));
        String text=raw.replaceAll(POLICY.get("trimPattern").getAsString(),"");
        if(text.isEmpty())return new Result(false,null,message("empty"));
        if(Pattern.compile(POLICY.get("controlPattern").getAsString()).matcher(text).find())return new Result(false,null,message("control"));
        for(JsonElement rule:POLICY.getAsJsonArray("blockedRequests"))
            if(Pattern.compile(rule.getAsString(),Pattern.CASE_INSENSITIVE).matcher(text).find())return new Result(false,null,message("blocked"));
        return new Result(true,text,null);
    }
}
