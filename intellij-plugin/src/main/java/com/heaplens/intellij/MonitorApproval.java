package com.heaplens.intellij;

import com.heaplens.monitor.MonitorActions;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.ui.Messages;
import java.util.function.*;

final class MonitorApproval implements MonitorActions.Approval {
    private final Project project;
    MonitorApproval(Project project){this.project=project;}
    public void ask(String host,int port,boolean histogram,BooleanSupplier active,Consumer<Boolean> reply){
        ApplicationManager.getApplication().invokeLater(()->{
            if(!active.getAsBoolean() || project==null || project.isDisposed())return;
            String detail=histogram?"Request a live class histogram? This diagnostic operation may pause the target JVM."
                :"Connect to the existing HeapLens JVM agent and poll metrics every 2 seconds? This is not a JMX port. The agent protocol has no TLS or authentication. Use localhost or a trusted tunnel; do not expose it publicly.";
            int result=Messages.showYesNoDialog(project,detail+"\n\nDestination: "+host+":"+port+"\nNothing connects automatically when a dump opens.",
                histogram?"HeapLens: Live Histogram":"HeapLens: Connect Monitor",histogram?"Request Histogram":"Connect","Cancel",Messages.getWarningIcon());
            if(active.getAsBoolean())reply.accept(result==Messages.YES);
        });
    }
}
