package com.heaplens.ai;

import java.util.List;

public interface LlmTransport extends AutoCloseable {
    record Message(String role, String content) { }
    interface Listener { void chunk(String text); void done(); void error(String safeMessage); }
    interface Call { void cancel(); }
    Call start(AiConfiguration config, List<Message> messages, Listener listener);
    @Override void close();
}
