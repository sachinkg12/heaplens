package com.heaplens.intellij;

import com.google.gson.JsonObject;
import com.heaplens.telemetry.DiagnosticSink;
import com.heaplens.telemetry.TelemetryClient;
import java.util.Map;

/** Host permission gate: no collection before a decision and no replay of earlier activity. */
final class TelemetryPermission implements DiagnosticSink,AutoCloseable {
    private final TelemetryPreferences preferences;
    private final TelemetryClient client;
    private final boolean disabled;
    private boolean promptOpen,closed;
    TelemetryPermission(TelemetryPreferences preferences,TelemetryClient client,boolean disabled){
        this.preferences=preferences;this.client=client;this.disabled=disabled;
        client.setLevel(disabled?"off":preferences.level());
    }
    synchronized boolean beginPrompt(){
        if(closed || disabled || preferences.decided() || promptOpen)return false;
        promptOpen=true;return true;
    }
    synchronized void abandonPrompt(){promptOpen=false;}
    synchronized boolean promptPending(){return promptOpen && !closed && !preferences.decided();}
    synchronized void finishPrompt(int choice){
        if(!promptOpen || closed)return;
        // Closing/dismissing the first dialog is a remembered denial, never implicit permission.
        choose(choice==0?"error":choice==1?"all":"off");
    }
    synchronized void choose(String choice){
        if(closed)return;
        promptOpen=false;preferences.save(choice);client.setLevel(disabled?"off":preferences.level());
    }
    @Override public synchronized void track(String name,Map<String,String> properties,Map<String,Double> measurements){
        if(closed || disabled || !preferences.decided() || preferences.level().equals("off"))return;
        client.track(name,properties,measurements);
    }
    synchronized String level(){return client.level();}
    synchronized boolean disabled(){return disabled;}
    synchronized JsonObject report(){return client.report();}
    @Override public synchronized void close(){closed=true;promptOpen=false;client.close();}
}
