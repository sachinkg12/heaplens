package com.heaplens.session;

/** Explicit commands are the only escalation boundary. */
public final class ProgressiveActions {
    private ProgressiveActions() { }
    public static CommandRouter register(CommandRouter router, HeapSession session) {
        return router.with("quickScan", ignored->session.analyze(AnalysisMode.SHALLOW))
            .with("analyzeRetained", ignored->session.analyze(AnalysisMode.FULL));
    }
}
