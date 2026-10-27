package com.heaplens.intellij;

import com.heaplens.ai.AiConfiguration;
import com.intellij.openapi.components.*;

/** Application settings, not workspace configuration. Never add credential fields here. */
@Service(Service.Level.APP)
@State(name="HeapLensAi",storages=@Storage(value="heaplens-ai.xml",roamingType=RoamingType.DISABLED))
public final class AiPreferences implements PersistentStateComponent<AiPreferences.Values> {
    public static final class Values {
        public String provider="openai";
        public String baseUrl="";
        public String model="";
    }
    private Values values=new Values();
    private final java.util.concurrent.CopyOnWriteArrayList<Runnable> listeners=new java.util.concurrent.CopyOnWriteArrayList<>();
    public AutoCloseable listen(Runnable action){listeners.add(action);return ()->listeners.remove(action);}
    public synchronized Values getState() {
        Values copy=new Values();copy.provider=values.provider;copy.baseUrl=values.baseUrl;copy.model=values.model;return copy;
    }
    public void loadState(Values state) {
        synchronized(this){Values copy=new Values();copy.provider=state.provider;copy.baseUrl=state.baseUrl;copy.model=state.model;values=copy;}
        listeners.forEach(action->{try{action.run();}catch(RuntimeException ignored){}});
    }
    public synchronized AiConfiguration.Settings snapshot() {return new AiConfiguration.Settings(values.provider,values.baseUrl,values.model);}
    public void save(AiConfiguration.Settings settings) {
        synchronized(this){Values next=new Values();next.provider=settings.provider();next.baseUrl=settings.baseUrl();next.model=settings.model();values=next;}
        listeners.forEach(action->{try{action.run();}catch(RuntimeException ignored){}});
    }
}
