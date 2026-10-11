package com.heaplens.monitor;

import com.google.gson.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.function.Consumer;

/** Bounded line protocol for the existing JVM agent. Never starts or attaches to an application. */
public final class AgentMonitor implements AutoCloseable {
    private final Consumer<JsonObject> output;
    private final ScheduledExecutorService workers=Executors.newScheduledThreadPool(2,r->{Thread t=new Thread(r,"heaplens-monitor");t.setDaemon(true);return t;});
    private Socket socket;
    private OutputStream writer;
    private ScheduledFuture<?> poll;
    private boolean closed,connected,histogramPending;
    private long histogramDeadline;
    public AgentMonitor(Consumer<JsonObject> output){this.output=output;}
    public void connect(String host,int port){workers.execute(()->{
        Socket candidate=new Socket();synchronized(this){if(closed){closeSocket(candidate);return;}socket=candidate;}
        try {
            candidate.connect(new InetSocketAddress(host,port),5000);candidate.setSoTimeout(35000);candidate.setTcpNoDelay(true);
            synchronized(this){if(closed)return;writer=candidate.getOutputStream();connected=true;emit("monitorConnected",null,null);
                poll=workers.scheduleWithFixedDelay(()->{synchronized(this){
                    // Agent replies have no request IDs. Retire the connection on timeout
                    // so a late histogram can never satisfy a newer request.
                    if(histogramPending && System.nanoTime()>histogramDeadline){fail("Histogram timed out. Reconnect before trying again; the target JVM may be busy.");return;}
                    if(!histogramPending)send("get_metrics");
                }},0,2,TimeUnit.SECONDS);}
            InputStream input=candidate.getInputStream();ByteArrayOutputStream line=new ByteArrayOutputStream();int b;
            while((b=input.read())!=-1){
                if(b=='\n'){accept(line.toString(StandardCharsets.UTF_8));line.reset();}
                else {if(line.size()>=1024*1024)throw new IOException("oversized frame");line.write(b);}
            }
            fail("Agent disconnected. Reconnect when it is available.");
        }catch(Exception failure){fail("Monitor connection failed or timed out. Check the agent, host, port and firewall.");}
        finally{closeSocket(candidate);}
    });}
    public synchronized void histogram(){
        if(!connected || closed){emit("monitorError","message",new JsonPrimitive("Connect to an agent first."));return;}
        if(histogramPending)return;histogramPending=true;histogramDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(30);send("get_histogram");
    }
    private synchronized void send(String command){
        if(closed || !connected)return;
        try{writer.write(("{\"command\":\""+command+"\"}\n").getBytes(StandardCharsets.UTF_8));writer.flush();}
        catch(IOException failure){fail("Agent connection lost. Reconnect to continue.");}
    }
    private synchronized void accept(String line)throws IOException {
        if(closed)return;
        try {
            JsonObject frame=JsonParser.parseString(line).getAsJsonObject();String type=frame.get("type").getAsString();
            if(type.equals("pong"))return;
            if(type.equals("error")){histogramPending=false;emit("monitorError","message",new JsonPrimitive("The agent could not complete the request. Check its local log."));return;}
            JsonElement data=frame.get("data");
            if(type.equals("metrics")){
                JsonObject raw=data.getAsJsonObject(),safe=new JsonObject();
                for(String key:new String[]{"timestamp","heapUsed","heapMax","heapCommitted","nonHeapUsed","nonHeapCommitted","threadCount","daemonThreadCount","uptime"})safe.add(key,number(raw,key));
                for(String key:new String[]{"gcCollectors","memoryPools"}){
                    JsonArray rows=new JsonArray();JsonArray values=raw.getAsJsonArray(key);if(values==null || values.size()>100)throw new IOException();
                    for(JsonElement value:values){JsonObject row=value.getAsJsonObject(),clean=new JsonObject();clean.addProperty("name",name(row,"name"));
                        if(key.equals("gcCollectors")){clean.add("collectionCount",number(row,"collectionCount"));clean.add("collectionTimeMs",number(row,"collectionTimeMs"));}
                        else {clean.addProperty("type",name(row,"type"));for(String field:new String[]{"used","max","committed"})clean.add(field,number(row,field));}
                        rows.add(clean);}
                    safe.add(key,rows);
                }
                emit("monitorMetrics","data",safe);
            }else if(type.equals("histogram")){
                if(!histogramPending)return;histogramPending=false;JsonArray raw=data.getAsJsonArray();if(raw.size()>50000)throw new IOException();
                JsonArray safe=new JsonArray();for(JsonElement value:raw){JsonObject row=value.getAsJsonObject(),clean=new JsonObject();
                    clean.addProperty("className",name(row,"className"));clean.add("instanceCount",number(row,"instanceCount"));clean.add("totalBytes",number(row,"totalBytes"));safe.add(clean);}
                emit("monitorHistogram","data",safe);
            }else throw new IOException();
        }catch(RuntimeException invalid){throw new IOException("Invalid agent response");}
    }
    private static JsonElement number(JsonObject value,String key)throws IOException{
        JsonElement field=value.get(key);if(field==null || !field.isJsonPrimitive() || !field.getAsJsonPrimitive().isNumber()
            || !Double.isFinite(field.getAsDouble()) || field.getAsDouble() < -1 || field.getAsDouble()>9007199254740991d)throw new IOException();return field;
    }
    private static String name(JsonObject value,String key)throws IOException{
        JsonElement field=value.get(key);if(field==null || !field.isJsonPrimitive() || !field.getAsJsonPrimitive().isString() || field.getAsString().length()>2048)throw new IOException();return field.getAsString();
    }
    private void emit(String command,String key,JsonElement value){if(closed)return;JsonObject event=new JsonObject();event.addProperty("command",command);if(key!=null)event.add(key,value);output.accept(event);}
    private synchronized void fail(String message){if(closed)return;emit("monitorDisconnected",null,null);emit("monitorError","message",new JsonPrimitive(message));close();}
    private static void closeSocket(Socket socket){if(socket!=null)try{socket.close();}catch(IOException ignored){}}
    @Override public synchronized void close(){if(closed)return;closed=true;connected=false;if(poll!=null)poll.cancel(false);closeSocket(socket);workers.shutdownNow();}
}
