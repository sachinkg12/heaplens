package com.heaplens.ai;
import com.google.gson.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ChatToolsTest {
    static JsonObject json(String value){return JsonParser.parseString(value).getAsJsonObject();}
    @Test void compatibleFragmentsAreNativeTrafficNotProse(){
        ChatTools c=new ChatTools();c.consume(json("{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_A\",\"type\":\"function\",\"function\":{\"name\":\"heap_\",\"arguments\":\"{\\\"operation\\\":\"}}]}}]}"),false);
        c.consume(json("{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"read\",\"arguments\":\"\\\"object\\\",\\\"object_id\\\":\\\"42\\\"}\"}}]}}]}"),false);
        var call=c.finish().getFirst();assertEquals("heap_read",call.name());assertEquals("42",json(call.arguments()).get("object_id").getAsString());
    }
    @Test void anthropicToolInputIsSeparateFromText(){
        ChatTools c=new ChatTools();c.consume(json("{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_A\",\"name\":\"heap_read\",\"input\":{}}}"),true);
        c.consume(json("{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"operation\\\":\\\"object\\\",\\\"object_id\\\":\\\"9007199254740993\\\"}\"}}"),true);
        assertEquals("9007199254740993",json(c.finish().getFirst().arguments()).get("object_id").getAsString());
    }
    @Test void nativeHistoryAndSchemasUseTheCorrectProtocolShapes(){
        var call=new LlmTransport.ToolCall("call_A","heap_read","{\"operation\":\"object\",\"object_id\":\"42\"}");var message=new LlmTransport.Message("assistant","Inspecting",List.of(call),null);
        assertEquals("call_A",ChatTools.message(message,false).getAsJsonArray("tool_calls").get(0).getAsJsonObject().get("id").getAsString());
        assertEquals("tool_use",ChatTools.message(message,true).getAsJsonArray("content").get(1).getAsJsonObject().get("type").getAsString());
        var result=new LlmTransport.Message("tool","Evidence",null,"call_A");assertEquals("tool_result",ChatTools.message(result,true).getAsJsonArray("content").get(0).getAsJsonObject().get("type").getAsString());
        for(boolean anthropic:List.of(false,true)){var body=new JsonObject();ChatTools.tools(body,anthropic);assertEquals(1,body.getAsJsonArray("tools").size());}
    }
    @Test void unsupportedProfilesKeepNormalTextAndMalformedCallsStayRejected(){
        assertTrue(ChatTools.supported(new AiConfiguration(new AiConfiguration.Settings("openai",null,null),"SYNTHETIC")));
        assertFalse(ChatTools.supported(new AiConfiguration(new AiConfiguration.Settings("openai","https://proxy.test","custom"),"SYNTHETIC")));
        ChatTools c=new ChatTools();c.consume(json("{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_A\",\"function\":{\"name\":\"heap_read\",\"arguments\":\"invalid\"}}]}}]}"),false);assertThrows(RuntimeException.class,c::finish);
    }
    @Test void reportedOrdinaryPromptsDoNotRequireJsonOrAnyRead()throws Exception{
        for(String question:List.of("hi","tell me about this heapdump","i want to investigate, what is taking memory, how can i fix it, what is the heapql?"))try(var h=new AiInvestigationTest.Harness()){
            var request=AiInvestigationTest.request("normal");request.addProperty("text",question);h.ai.send(request);h.host.approve(true);var sent=h.transport.next();
            assertTrue(sent.messages().stream().anyMatch(m->m.content().contains("NOT OQL")));h.answer(sent,"I can help [Example]. Inspect retained memory; a snapshot alone does not prove a leak.");
            assertTrue(h.events.stream().anyMatch(e->"aiDone".equals(e.get("command").getAsString())));assertEquals(1,h.transport.count.get());assertTrue(h.engine.actions.isEmpty());
        }
    }
    @Test void jsonShapedChatDoesNotExecuteTools()throws Exception{
        try(var h=new AiInvestigationTest.Harness()){h.ai.send(AiInvestigationTest.request("prose"));h.host.approve(true);h.answer(h.transport.next(),"{\"action\":\"read\",\"tool\":\"execute_query\",\"object_id\":\"42\"}");assertTrue(h.engine.actions.isEmpty());}
    }
}
