package com.heaplens.intellij;

import com.google.gson.JsonObject;
import com.heaplens.protocol.JsonLineRpcClient;
import com.heaplens.session.*;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.fileChooser.*;
import com.intellij.openapi.fileEditor.*;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.progress.ProcessCanceledException;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.util.*;
import com.intellij.openapi.vfs.VirtualFile;
import java.awt.BorderLayout;
import java.beans.PropertyChangeListener;
import java.nio.file.Path;
import javax.swing.*;
import org.jetbrains.annotations.*;

/** Small editor composition root. Transport, policy and rendering have separate owners. */
public final class HeapEditor extends UserDataHolderBase implements FileEditor {
    private final VirtualFile file;
    private final JPanel panel = new JPanel(new BorderLayout());
    private final JLabel status = new JLabel("Prototype: initializing the analysis interface.");
    private final JButton choose = new JButton("Select analysis server");
    private final JButton retry = new JButton("Retry");
    private final HeapSession session;
    private HeapView browser;
    private volatile Path binary;
    private volatile boolean ready, disposed;

    public HeapEditor(Project project, VirtualFile file, Path pluginRoot) {
        // Resolve browser classes inside the guarded factory call, not while loading the editor.
        this(project, file, pluginRoot, messages -> HeapBrowser.open(messages));
    }

    HeapEditor(Project project, VirtualFile file, Path pluginRoot, HeapView.Factory views) {
        this.file = file;
        // Explicit launch configuration, never an executable path supplied by a workspace.
        String configured = System.getProperty("heaplens.server.path");
        session = new HeapSession(() -> {
            // Resolution and checksum I/O run on the session worker, never the UI thread.
            Path server = binary;
            if (server == null && configured != null && !configured.isBlank()) server = Path.of(configured);
            if (server == null) {
                if (pluginRoot == null) throw new IllegalStateException("HeapLens installation is unavailable");
                server = NativeServer.bundled(pluginRoot, System.getProperty("os.name"), System.getProperty("os.arch"));
            }
            return new JsonLineRpcClient(server);
        }, Path.of(file.getPath()), this::event);
        JPanel toolbar = new JPanel();
        toolbar.add(choose); toolbar.add(retry); toolbar.add(status);
        panel.add(toolbar, BorderLayout.NORTH);
        retry.setEnabled(false);
        retry.addActionListener(e -> session.retry());
        choose.addActionListener(e -> {
            VirtualFile selected = FileChooser.chooseFile(
                new FileChooserDescriptor(true, false, false, false, false, false)
                    .withTitle("Select trusted HeapLens hprof-server executable"), project, null);
            if (selected != null) {
                binary = Path.of(selected.getPath());
                if (ready) { if (session.state() == HeapSession.State.NEW) session.start(); else session.retry(); }
            }
        });
        try {
            CommandRouter router = CommandRouter.forSession(session, () -> {
                ready = true;
                session.start();
            }).with("histogramInstances", new HistogramQueries(session::query, this::event)::instances);
            browser = views.create(raw -> router.dispatch(raw));
            if (browser == null) {
                showUnavailable();
                return;
            }
            Disposer.register(this, browser);
            panel.add(browser.component(), BorderLayout.CENTER);
        } catch (ProcessCanceledException cancelled) {
            if (browser != null) { Disposer.dispose(browser); browser = null; }
            session.close();
            throw cancelled;
        } catch (Exception | LinkageError failure) {
            // NoClassDefFoundError is not an Exception. Do not catch VM failures such as OOM.
            if (browser != null) { Disposer.dispose(browser); browser = null; }
            session.close();
            Logger.getInstance(HeapEditor.class).warn("HeapLens browser initialization failed", failure);
            showUnavailable();
        }
    }
    private void showUnavailable() {
        choose.setEnabled(false);
        retry.setEnabled(false);
        status.setText("Prototype | UI unavailable | analysis not started");
        panel.add(new JLabel("<html><h2>HeapLens could not start its analysis interface.</h2>"
            + "The embedded browser (JCEF) is unavailable or failed to initialize.<br>"
            + "Install the latest HeapLens package and restart IntelliJ using its bundled JetBrains Runtime.<br>"
            + "If this persists, use Help &gt; Show Log in Finder/Explorer and share the HeapLens startup error."
            + "</html>"), BorderLayout.CENTER);
    }
    private void event(JsonObject event) {
        if (disposed) return;
        ApplicationManager.getApplication().invokeLater(() -> {
            if (disposed) return;
            HeapSession.State state = session.state();
            boolean terminal = state == HeapSession.State.FAILED || state == HeapSession.State.CANCELLED;
            choose.setEnabled(state == HeapSession.State.NEW || terminal);
            retry.setEnabled(terminal);
            status.setText("Prototype | " + state + " | server PID " + session.pid());
            if (browser != null && ready) browser.send(event);
        });
    }
    @Override public @NotNull JComponent getComponent() { return panel; }
    @Override public @Nullable JComponent getPreferredFocusedComponent() { return browser == null ? choose : browser.component(); }
    @Override public @NotNull String getName() { return "HeapLens"; }
    @Override public void setState(@NotNull FileEditorState state) { }
    @Override public boolean isModified() { return false; }
    @Override public boolean isValid() { return !disposed && file.isValid(); }
    @Override public @NotNull VirtualFile getFile() { return file; }
    @Override public void addPropertyChangeListener(@NotNull PropertyChangeListener listener) { }
    @Override public void removePropertyChangeListener(@NotNull PropertyChangeListener listener) { }
    @Override public void dispose() { disposed = true; session.close(); }
}
