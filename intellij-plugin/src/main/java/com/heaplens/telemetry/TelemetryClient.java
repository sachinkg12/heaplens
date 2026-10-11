package com.heaplens.telemetry;

import com.google.gson.*;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;

/** Bounded, cancellable, in-memory delivery. Telemetry can never fail an analysis. */
public final class TelemetryClient implements DiagnosticSink,AutoCloseable {
    private final TelemetryContract contract;
    private final Function<JsonObject,CompletableFuture<Boolean>> send;
    private final boolean disabled;
    private final ArrayDeque<JsonObject> queue=new ArrayDeque<>(), recent=new ArrayDeque<>();
    private String level="off";
    private int submitted,accepted,dropped;
    private long generation;
    private CompletableFuture<Boolean> pending;
    public TelemetryClient(TelemetryContract contract,boolean disabled,Function<JsonObject,CompletableFuture<Boolean>> send) {
        this.contract=contract;this.disabled=disabled;this.send=send;
    }
    public synchronized void setLevel(String value) {
        String next=!disabled && value!=null && Set.of("off","error","all").contains(value)?value:"off";
        if(next.equals(level))return;level=next;generation++;queue.clear();
        // Withdrawal removes local activity too; Errors Only must not retain prior usage records.
        recent.clear();
        var retired=pending;pending=null;if(retired!=null)retired.cancel(true);
    }
    @Override public synchronized void track(String name,Map<String,String> properties,Map<String,Double> measurements) {
        try {
            if(level.equals("off"))return;
            JsonObject event=contract.record(name,properties,measurements);if(event==null)return;
            if(level.equals("error") && !event.get("category").getAsString().equals("error"))return;
            recent.add(event);if(recent.size()>20)recent.remove();
            if(queue.size()>=16 || submitted+queue.size()>=256){dropped++;return;}
            queue.add(event);pump();
        } catch(RuntimeException ignored) { /* Diagnostic failures do not cross this port. */ }
    }
    private void pump() {
        if(pending!=null || queue.isEmpty() || level.equals("off"))return;
        long current=generation;JsonObject event=queue.remove();submitted++;
        try {
            var future=send.apply(contract.envelope(event));pending=future;
            future.whenComplete((ok,error)-> { synchronized(this) {
                if(current!=generation || pending!=future)return;
                if(error==null && Boolean.TRUE.equals(ok))accepted++;pending=null;pump();
            }});
        } catch(RuntimeException ignored){pending=null;pump();}
    }
    public synchronized String level(){return level;}
    public synchronized JsonObject report() {
        JsonObject result=new JsonObject();result.addProperty("schemaVersion",1);result.addProperty("level",level);
        result.addProperty("submitted",submitted);result.addProperty("accepted",accepted);result.addProperty("queued",queue.size());result.addProperty("dropped",dropped);
        result.addProperty("note","Local allowlisted records; HTTP acceptance does not prove portal visibility. No stable IDs. Network services may process IP addresses.");
        JsonArray events=new JsonArray();recent.forEach(e->events.add(e.deepCopy()));result.add("events",events);return result;
    }
    @Override public synchronized void close(){setLevel("off");recent.clear();}
}
