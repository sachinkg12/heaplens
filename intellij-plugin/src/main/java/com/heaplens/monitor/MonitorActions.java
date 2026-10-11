package com.heaplens.monitor;

import com.google.gson.*;
import com.heaplens.session.*;
import java.util.function.*;

/** Each editor owns its connection. User confirmation precedes any network request. */
public final class MonitorActions implements AutoCloseable {
    public interface Approval {void ask(String host,int port,boolean histogram,BooleanSupplier active,Consumer<Boolean> reply);}
    private final Approval approval;
    private final Consumer<JsonObject> output;
    private AgentMonitor monitor;
    private long generation;
    private boolean closed,pending;
    private String host;private int port;
    public MonitorActions(Approval approval,Consumer<JsonObject> output){this.approval=approval;this.output=output;}
    public CommandRouter register(CommandRouter router){return router.with("startMonitor",this::start)
        .with("stopMonitor",m->stop()).with("requestMonitorHistogram",m->histogram());}
    public synchronized void start(JsonObject message){
        if(closed)return;if(monitor!=null || pending){error("Disconnect the current monitor first.");return;}
        try{
            String target=message.get("host").getAsString();int targetPort=message.get("port").getAsBigDecimal().intValueExact();
            if(target.length()>253 || !target.matches("[A-Za-z0-9:.\\-]+") || targetPort<1 || targetPort>65535)throw new IllegalArgumentException();
            host=target;port=targetPort;pending=true;long token=++generation;
            approval.ask(target,targetPort,false,()->active(token),accepted->{synchronized(this){
                if(!active(token)||!pending)return;pending=false;
                if(!accepted){error("Connection cancelled. No network request was made.");return;}
                monitor=new AgentMonitor(event->{synchronized(this){if(active(token)){if(event.get("command").getAsString().equals("monitorDisconnected")){monitor=null;pending=false;}output.accept(event);}}});
                monitor.connect(target,targetPort);
            }});
        }catch(RuntimeException invalid){pending=false;error("Enter a valid agent host and port (1–65535).");}
    }
    private synchronized boolean active(long token){return !closed && token==generation;}
    private void histogram(){
        final long token;final String target;final int targetPort;
        synchronized(this){if(monitor==null || pending){error("Connect first or finish the pending confirmation.");return;}
            token=generation;pending=true;target=host;targetPort=port;}
        approval.ask(target,targetPort,true,()->active(token),accepted->{AgentMonitor selected;synchronized(this){
            if(!active(token)||!pending)return;pending=false;
            selected=accepted?monitor:null;if(selected==null)error("Histogram request cancelled.");
        }if(selected!=null)selected.histogram();});
    }
    public void stop(){AgentMonitor old;synchronized(this){generation++;pending=false;old=monitor;monitor=null;}if(old!=null)old.close();
        synchronized(this){if(!closed)output.accept(WebviewEvents.event("monitorDisconnected"));}}
    private void error(String text){JsonObject event=WebviewEvents.event("monitorError");event.addProperty("message",text);output.accept(event);}
    @Override public void close(){synchronized(this){closed=true;}stop();}
}
