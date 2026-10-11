package com.heaplens.telemetry;

import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;

/** Same versioned resource as VS Code and CLI; no unrestricted strings or SDK metadata. */
public final class TelemetryContract {
    private final JsonObject schema;
    private final String host, version, os, arch;
    public TelemetryContract(String host, String version, String os, String arch) {
        try (InputStream stream = TelemetryContract.class.getResourceAsStream("/heaplens-telemetry/contract.json")) {
            if (stream == null) throw new IOException("Contract missing");
            schema = JsonParser.parseReader(new InputStreamReader(stream, StandardCharsets.UTF_8)).getAsJsonObject();
        } catch (IOException failure) { throw new IllegalStateException("Telemetry contract unavailable", failure); }
        this.host=host;this.os=os;this.arch=arch;
        this.version=version!=null && version.matches("(?:unknown|[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}(?:-[a-z0-9.-]{1,24})?)")?version:"unknown";
    }
    private static boolean contains(JsonElement values,String value) {
        return values!=null && values.isJsonArray() && values.getAsJsonArray().contains(new JsonPrimitive(value));
    }
    public JsonObject record(String name, Map<String,String> properties, Map<String,Double> measurements) {
        JsonObject events=schema.getAsJsonObject("events");
        if (!events.has(name) || !contains(schema.get("hosts"),host) || !contains(schema.get("platforms"),os) || !contains(schema.get("architectures"),arch)) return null;
        JsonObject event=events.getAsJsonObject(name), props=new JsonObject(), metrics=new JsonObject();
        for (var item:properties.entrySet()) {
            if (!contains(event.get("properties"),item.getKey()) || !contains(schema.getAsJsonObject("enums").get(item.getKey()),item.getValue())) return null;
            props.addProperty(item.getKey(),item.getValue());
        }
        for (var item:measurements.entrySet()) {
            if (!contains(event.get("measurements"),item.getKey()) || item.getValue()==null) return null;
            JsonObject bounds=schema.getAsJsonObject("metrics").getAsJsonObject(item.getKey());double value=item.getValue(),quantum=bounds.get("quantum").getAsDouble();
            if (!Double.isFinite(value) || value<0 || value>bounds.get("max").getAsDouble()) return null;
            metrics.addProperty(item.getKey(),Math.floor(value/quantum)*quantum);
        }
        props.addProperty("schemaVersion",schema.get("schemaVersion").getAsString());props.addProperty("host",host);
        props.addProperty("version",version);props.addProperty("os",os);props.addProperty("arch",arch);
        JsonObject result=new JsonObject();result.addProperty("name",name);result.add("category",event.get("category"));
        result.add("properties",props);result.add("measurements",metrics);return result;
    }
    public JsonObject envelope(JsonObject event) {
        JsonObject result=new JsonObject(),data=new JsonObject(),base=new JsonObject();
        result.addProperty("ver",1);result.addProperty("name","Microsoft.ApplicationInsights.Event");result.addProperty("time",Instant.now().toString());
        result.add("iKey",schema.get("instrumentationKey"));result.add("tags",new JsonObject());
        data.addProperty("baseType","EventData");base.addProperty("ver",2);base.addProperty("name","heaplens/"+event.get("name").getAsString());
        base.add("properties",event.get("properties").deepCopy());base.add("measurements",event.get("measurements").deepCopy());
        data.add("baseData",base);result.add("data",data);return result;
    }
    public String endpoint() { return schema.get("endpoint").getAsString(); }
    public static String os(String value) { return value.startsWith("Mac")?"darwin":value.startsWith("Windows")?"win32":value.equals("Linux")?"linux":"unknown"; }
    public static String arch(String value) { return switch(value) {case "arm64","aarch64"->"arm64";case "x64","amd64","x86_64"->"x64";default->"unknown";}; }
}
