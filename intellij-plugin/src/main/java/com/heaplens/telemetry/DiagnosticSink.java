package com.heaplens.telemetry;

import java.util.Map;

/** Optional observer port. Engine/session code never owns consent or network delivery. */
@FunctionalInterface
public interface DiagnosticSink {
    DiagnosticSink NONE = (name, properties, measurements) -> {};
    void track(String name, Map<String,String> properties, Map<String,Double> measurements);
}
