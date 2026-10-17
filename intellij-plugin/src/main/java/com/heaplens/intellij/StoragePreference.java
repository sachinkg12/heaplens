package com.heaplens.intellij;

import com.intellij.ide.util.PropertiesComponent;
import java.nio.file.Path;
import java.util.List;
import javax.swing.JCheckBox;
import com.google.gson.JsonObject;

/** Host preference only; index construction, validity and storage belong to Rust. */
final class StoragePreference {
    final JCheckBox control;
    private volatile boolean disk;
    StoragePreference() {
        PropertiesComponent prefs;
        try { prefs=PropertiesComponent.getInstance(); } catch(RuntimeException unavailable) { prefs=null; }
        final PropertiesComponent settings=prefs;
        if(settings!=null)try{disk=settings.getBoolean("heaplens.diskReferences",false);}catch(RuntimeException unavailable){/* Memory default. */}
        control=new JCheckBox("Disk-backed references",disk);
        control.setToolTipText("Applies to newly started servers: close and reopen the dump after changing. Uses private reusable indices; node metadata and dominators still use RAM.");
        control.addActionListener(event->{disk=control.isSelected();if(settings!=null)try{settings.setValue("heaplens.diskReferences",disk,false);}catch(RuntimeException unavailable){/* Current selection remains usable. */}});
    }
    List<String> command(Path server) { return List.of(server.toString(),"--storage",disk?"disk":"memory"); }
    static String label(JsonObject event) {
        if(!event.has("storage") || !event.get("storage").isJsonObject())return "";
        JsonObject storage=event.getAsJsonObject("storage");
        for(String key:List.of("mode","cache_status"))if(!storage.has(key)||!storage.get(key).isJsonPrimitive()||!storage.getAsJsonPrimitive(key).isString())return "";
        String mode=storage.get("mode").getAsString(),cache=storage.get("cache_status").getAsString();
        if(!List.of("memory","disk").contains(mode)||!List.of("disabled","built","reused").contains(cache))return "";
        return " | references: "+mode+" | cache: "+cache;
    }
}
