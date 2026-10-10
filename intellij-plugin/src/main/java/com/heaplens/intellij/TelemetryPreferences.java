package com.heaplens.intellij;

import com.intellij.openapi.components.*;

/** Application-only, unsynced permission. A legacy level is not explicit consent. */
@Service(Service.Level.APP)
@State(name="HeapLensTelemetry",storages=@Storage(value="heaplens-telemetry.xml",roamingType=RoamingType.DISABLED))
public final class TelemetryPreferences implements PersistentStateComponent<TelemetryPreferences.Values> {
    static final int CONSENT_VERSION=1;
    // Older Off XML can omit level. Keep that bean default, adding a separate permission marker.
    public static final class Values {public String level="off";public int consentVersion;}
    private String level="off";
    private boolean decided;
    public synchronized Values getState(){Values value=new Values();value.level=level;value.consentVersion=decided?CONSENT_VERSION:0;return value;}
    public synchronized void loadState(Values value){
        decided=value!=null && value.consentVersion==CONSENT_VERSION && valid(value.level);
        level=decided?value.level:"off";
    }
    private static boolean valid(String value){return value!=null && java.util.Set.of("off","error","all").contains(value);}
    public synchronized String level(){return level;}
    public synchronized boolean decided(){return decided;}
    public synchronized void save(String value){
        Values next=new Values();next.level=value;next.consentVersion=valid(value)?CONSENT_VERSION:0;loadState(next);
    }
}
