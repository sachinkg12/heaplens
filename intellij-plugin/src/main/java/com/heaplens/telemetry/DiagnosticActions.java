package com.heaplens.telemetry;

import java.util.Map;

/** Action-name projection. Never inspect or transmit a webview message body. */
public final class DiagnosticActions {
    private DiagnosticActions(){}
    private static final Map<String,String> EVENTS=Map.ofEntries(
        Map.entry("aiSend","feature/chatMessage"),Map.entry("openProjectSource","feature/goToSource"),
        Map.entry("fixWithAi","feature/fixWithAi"),Map.entry("explainObject","feature/explainObject"),
        Map.entry("explainLeakSuspect","feature/explainLeakSuspect"),Map.entry("inspectObject","feature/inspectObject"),
        Map.entry("gcRootPath","feature/gcRootPath"),Map.entry("compareHeaps","feature/compareHeaps"),
        Map.entry("exportHistogramCsv","feature/export"),Map.entry("copyReportText","feature/export"),
        Map.entry("exportCompareCsv","feature/export"),Map.entry("exportCompareMarkdown","feature/export"));
    public static void requested(DiagnosticSink sink,String command) {
        String event=EVENTS.get(command);if(event!=null)sink.track(event,Map.of(),Map.of());
    }
}
