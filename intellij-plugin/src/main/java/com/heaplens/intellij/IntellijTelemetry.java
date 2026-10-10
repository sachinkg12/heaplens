package com.heaplens.intellij;

import com.heaplens.telemetry.*;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import com.intellij.testFramework.LightVirtualFile;
import com.intellij.openapi.fileEditor.FileEditorManager;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.*;
import java.util.function.BooleanSupplier;

/** Native host owns telemetry policy/UI/HTTPS; analysis and shared rendering stay unaware. */
@Service(Service.Level.APP)
public final class IntellijTelemetry implements Disposable,DiagnosticSink {
    private final TelemetryPermission permission;
    private final ExecutorService network=Executors.newSingleThreadExecutor(r->{Thread t=new Thread(r,"heaplens-telemetry");t.setDaemon(true);return t;});
    private final HttpClient http;
    public IntellijTelemetry() {
        var contract=new TelemetryContract("intellij",packagedVersion(),TelemetryContract.os(System.getProperty("os.name","")),TelemetryContract.arch(System.getProperty("os.arch","")));
        http=HttpClient.newBuilder().executor(network).connectTimeout(Duration.ofSeconds(1)).followRedirects(HttpClient.Redirect.NEVER).build();
        boolean disabled=ApplicationManager.getApplication().isUnitTestMode() || Boolean.getBoolean("heaplens.telemetry.disabled") || System.getenv("CI")!=null || "1".equals(System.getenv("DO_NOT_TRACK"));
        var client=new TelemetryClient(contract,disabled,body->{var pending=http.sendAsync(HttpRequest.newBuilder(URI.create(contract.endpoint()))
            .timeout(Duration.ofSeconds(1)).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(body.toString())).build(),HttpResponse.BodyHandlers.discarding())
            ;var result=new CompletableFuture<Boolean>();
            pending.whenComplete((response,error)->{if(error!=null)result.complete(false);else result.complete(response.statusCode()==200);});
            result.orTimeout(1,TimeUnit.SECONDS);
            result.whenComplete((ok,error)->{if(result.isCancelled() || error!=null)pending.cancel(true);});return result;});
        permission=new TelemetryPermission(preferences(),client,disabled);
    }
    // Read our own generated resource, not an internal IDE plugin-manager API.
    static String packagedVersion() {
        try(InputStream input=IntellijTelemetry.class.getResourceAsStream("/heaplens-telemetry/host-version.properties")) {
            if(input==null)return "unknown";
            var metadata=new Properties();metadata.load(input);
            return metadata.getProperty("version","unknown");
        } catch(IOException | IllegalArgumentException unavailable) {return "unknown";}
    }
    private TelemetryPreferences preferences(){return ApplicationManager.getApplication().getService(TelemetryPreferences.class);}
    @Override public void track(String name,Map<String,String> properties,Map<String,Double> measurements){permission.track(name,properties,measurements);}
    public void requestConsent(Project project,BooleanSupplier active) {
        if(!permission.beginPrompt())return;
        ApplicationManager.getApplication().invokeLater(()->{
            if(!permission.promptPending())return;
            if(!active.getAsBoolean() || project!=null && project.isDisposed()){permission.abandonPrompt();return;}
            try {
                int choice=Messages.showDialog(project,"HeapLens telemetry is OFF until you choose to enable it. Analysis works with telemetry off.\n\n"+
                    "If enabled, filtered records go to HeapLens Azure Application Insights:\n"+
                    "Errors Only: bounded failure codes and phases, plus host/version/platform.\n"+
                    "Usage and Errors: also actions and rounded sizes, counts and timings.\n"+
                    "No dump/source/query text, paths, keys, class names or stable user/session IDs are included.\n"+
                    "Network services may process IP addresses; this is data minimization, not guaranteed anonymity.\n\n"+
                    "Your choice is saved for this IDE application, not synced. Telemetry > Off withdraws it.\n"+
                    "Closing this dialog keeps telemetry off. Nothing from before approval is replayed.",
                    "HeapLens: Allow Telemetry?",new String[]{"Enable Errors Only","Enable Usage and Errors","No Telemetry"},2,Messages.getQuestionIcon());
                if(active.getAsBoolean() && (project==null || !project.isDisposed()))permission.finishPrompt(choice);
                else permission.abandonPrompt();
            } catch(RuntimeException unavailable){permission.abandonPrompt();}
        });
    }
    public void configure(Project project) {
        int choice=Messages.showDialog(project,"Telemetry requires explicit permission. Choose Off to disable collection and delivery.\nFiltered diagnostics go to HeapLens Azure Application Insights.\nErrors: bounded codes and phase, plus host/version/platform. Usage: also actions and rounded sizes/counts/timings.\nNo paths, dump/source/query text, keys, class names or stable user/session IDs.\nNetwork services may process IP addresses. Off clears local records and pending delivery; already sent records cannot be recalled.\nReview Local opens recent permitted records without uploading the report."+
            (permission.disabled()?"\nReporting is disabled by this launch's development/CI/do-not-track setting.":""),
            "HeapLens Telemetry (current: "+permission.level()+")",new String[]{"Off","Enable Errors Only","Enable Usage and Errors","Review Local","Cancel"},4,Messages.getQuestionIcon());
        if(choice>=0 && choice<3)permission.choose(new String[]{"off","error","all"}[choice]);
        else if(choice==3){FileEditorManager.getInstance(project).openFile(new LightVirtualFile("HeapLens Local Diagnostics.json",permission.report().toString()),true);}
    }
    @Override public void dispose(){permission.close();http.shutdown();network.shutdownNow();}
}
