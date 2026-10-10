package com.heaplens.ai;

import com.google.gson.*;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Bounded local IDE-system storage, never inside a project or a settings-sync file. */
public final class FileChatHistoryStore implements ChatHistoryStore {
    private final Path file;
    public FileChatHistoryStore(Path directory,String identity) {
        try {file=directory.resolve(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(identity.getBytes(StandardCharsets.UTF_8)))+".json");}
        catch(Exception impossible){throw new IllegalStateException("History identity unavailable");}
    }
    public synchronized Entry load() {
        try {
            if(!Files.isRegularFile(file,LinkOption.NOFOLLOW_LINKS) || Files.size(file)>256*1024) return empty();
            JsonObject data=JsonParser.parseString(Files.readString(file,StandardCharsets.UTF_8)).getAsJsonObject();
            String destination=data.get("destination").getAsString();
            if(destination.length()>4096)return empty();
            List<LlmTransport.Message> messages=new ArrayList<>();int size=0;
            for(JsonElement raw:data.getAsJsonArray("messages")) {
                JsonObject row=raw.getAsJsonObject();String role=row.get("role").getAsString(),text=row.get("content").getAsString();
                if(!role.equals(messages.size()%2==0?"user":"assistant") || messages.size()>=8 || text.length()>32768)return empty();
                size+=text.length();if(size>24000)return empty();messages.add(new LlmTransport.Message(role,text));
            }
            return messages.size()%2==0 ? new Entry(destination,List.copyOf(messages)) : empty();
        } catch(Exception invalid){return empty();}
    }
    private static Entry empty(){return new Entry(null,List.of());}
    public synchronized void save(Entry entry) {
        if(entry.messages().isEmpty()){clear();return;}
        Path temporary=null;
        try {
            Files.createDirectories(file.getParent());
            temporary=Files.createTempFile(file.getParent(),"history-",".tmp");
            try {Files.setPosixFilePermissions(temporary,PosixFilePermissions.fromString("rw-------"));}catch(UnsupportedOperationException ignored){ }
            Files.writeString(temporary,new Gson().toJson(entry),StandardCharsets.UTF_8);
            Files.move(temporary,file,StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
        } catch(Exception failure){throw new IllegalStateException("Chat history could not be saved locally");}
        finally {if(temporary!=null)try {Files.deleteIfExists(temporary);}catch(java.io.IOException ignored){ }}
    }
    public synchronized void clear(){try {Files.deleteIfExists(file);}catch(java.io.IOException failure){throw new IllegalStateException("Chat history could not be removed");}}
}
