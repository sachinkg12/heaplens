package com.heaplens.intellij;

import com.google.gson.JsonObject;
import com.heaplens.session.*;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.fileChooser.*;
import com.intellij.openapi.ide.CopyPasteManager;
import com.intellij.openapi.project.Project;
import com.intellij.util.concurrency.AppExecutorUtil;
import java.awt.datatransfer.StringSelection;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.function.*;

/** Local, explicitly clicked exports. No network and no page-selected output path. */
final class LocalExports {
    private final Project project;
    private final BooleanSupplier ready;
    private final Consumer<JsonObject> output;
    LocalExports(Project project, BooleanSupplier ready, Consumer<JsonObject> output) {this.project=project;this.ready=ready;this.output=output;}
    CommandRouter register(CommandRouter router) {
        return router.with("copyReportText",this::copy).with("exportHistogramCsv",this::csv)
            .with("exportCompareCsv",this::csv).with("exportCompareMarkdown",this::copy);
    }
    private String content(JsonObject message,String key) {
        if(!ready.getAsBoolean() || !message.has(key) || !message.get(key).isJsonPrimitive()
            || !message.get(key).getAsJsonPrimitive().isString()) throw new IllegalArgumentException("Export unavailable");
        String value=message.get(key).getAsString();
        if(value.length()>16*1024*1024) throw new IllegalArgumentException("Export exceeds size limit");
        return value;
    }
    private void result(String message) {
        JsonObject reply=WebviewEvents.event("localActionStatus");reply.addProperty("message",message);output.accept(reply);
    }
    private void copy(JsonObject message) {
        boolean compare=message.get("command").getAsString().equals("exportCompareMarkdown");
        String text=content(message,compare?"markdown":"text");
        ApplicationManager.getApplication().invokeLater(()->{
            if(!ready.getAsBoolean()) return;
            CopyPasteManager.getInstance().setContents(new StringSelection(text));
            output.accept(WebviewEvents.event(compare?"compareReportCopied":"reportCopied"));
        });
    }
    private void csv(JsonObject message) {
        String csv=content(message,"csv");
        ApplicationManager.getApplication().invokeLater(()->{
            if(!ready.getAsBoolean()) return;
            boolean compare=message.get("command").getAsString().equals("exportCompareCsv");
            var destination=FileChooserFactory.getInstance().createSaveFileDialog(
                new FileSaverDescriptor("Export HeapLens CSV","Save the displayed results locally","csv"),project)
                .save((com.intellij.openapi.vfs.VirtualFile)null,compare?"comparison.csv":"histogram.csv");
            if(destination==null) {result("CSV export cancelled.");return;}
            AppExecutorUtil.getAppExecutorService().execute(()->{
                try {Files.writeString(destination.getFile().toPath(),csv,StandardCharsets.UTF_8);result("CSV saved locally.");}
                catch(java.io.IOException failure) {result("CSV could not be saved. Check the selected location and permissions.");}
            });
        });
    }
}
