package com.heaplens.ai;

import java.util.List;

public interface LlmTransport extends AutoCloseable {
    record ToolCall(String id,String name,String arguments) { }
    record Message(String role, String content, List<ToolCall> toolCalls,String toolCallId) {
        public Message(String role,String content){this(role,content,null,null);}
    }
    interface Listener { void chunk(String text); void done(); void error(String safeMessage); default void tools(List<ToolCall> calls) { } }
    interface Call { void cancel(); }
    Call start(AiConfiguration config, List<Message> messages, Listener listener);
    default Call startChat(AiConfiguration config,List<Message> messages,boolean tools,Listener listener){return start(config,messages,listener);}
    @Override void close();
}
