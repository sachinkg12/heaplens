package com.heaplens.ai;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class FileChatHistoryStoreTest {
    @TempDir Path directory;
    @Test void completedHistorySurvivesReopenIsScopedAndClearDeletesIt()throws Exception {
        var store=new FileChatHistoryStore(directory,"project/dump-A/mtime");
        var saved=new ChatHistoryStore.Entry("provider-and-endpoint",List.of(new LlmTransport.Message("user","Question"),new LlmTransport.Message("assistant","Answer")));
        store.save(saved);assertEquals(saved,new FileChatHistoryStore(directory,"project/dump-A/mtime").load());
        assertTrue(new FileChatHistoryStore(directory,"other/dump-A/mtime").load().messages().isEmpty());
        assertTrue(new FileChatHistoryStore(directory,"project/dump-A/changed-mtime").load().messages().isEmpty());
        try(var files=Files.list(directory)){assertTrue(files.allMatch(p->p.getFileName().toString().matches("[0-9a-f]{64}\\.json")));}
        store.clear();assertTrue(store.load().messages().isEmpty());
    }
    @Test void malformedOversizedAndPartialHistoryCannotRestore()throws Exception {
        var store=new FileChatHistoryStore(directory,"identity");
        store.save(new ChatHistoryStore.Entry("destination",List.of(new LlmTransport.Message("user","unfinished"))));
        assertTrue(store.load().messages().isEmpty());
        Path path;try(var files=Files.list(directory)){path=files.findFirst().orElseThrow();}
        Files.writeString(path,"not-json");assertTrue(store.load().messages().isEmpty());
        Files.writeString(path,"x".repeat(300000));assertTrue(store.load().messages().isEmpty());
    }
}
