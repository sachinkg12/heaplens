package com.heaplens.session;

/** Wire capabilities, not an alternate heap engine. */
public enum AnalysisMode {
    FULL("analyze_heap", "heap_analysis_progress", "heap_analysis_complete", "full"),
    SHALLOW("scan_heap", "heap_scan_progress", "heap_scan_complete", "shallow");
    final String request, progress, completion, scope;
    AnalysisMode(String request, String progress, String completion, String scope) {
        this.request=request; this.progress=progress; this.completion=completion; this.scope=scope;
    }
}
