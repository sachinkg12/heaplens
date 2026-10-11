package com.heaplens.ai;

import java.util.List;

/** Completed text turns only. No keys, source files, raw heap values or query results. */
public interface ChatHistoryStore {
    record Entry(String destination,List<LlmTransport.Message> messages) { }
    Entry load();
    void save(Entry entry);
    void clear();
    ChatHistoryStore NONE=new ChatHistoryStore(){
        public Entry load(){return new Entry(null,List.of());}
        public void save(Entry entry) { }
        public void clear() { }
    };
}
