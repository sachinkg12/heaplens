package com.heaplens.intellij;

import com.google.gson.JsonObject;
import com.heaplens.protocol.JsonLineRpcClient;
import com.heaplens.session.*;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.fileChooser.*;
import com.intellij.openapi.fileEditor.*;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.*;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.ui.jcef.JBCefApp;
import java.awt.BorderLayout;
import java.beans.PropertyChangeListener;
import java.nio.file.Path;
import javax.swing.*;
import org.jetbrains.annotations.*;

/** Small editor composition root. Transport, policy and rendering have separate owners. */
public final class HeapEditor extends UserDataHolderBase implements FileEditor {
    private final VirtualFile file;
    private final JPanel panel = new JPanel(new BorderLayout());
    private final JLabel status = new JLabel("Prototype: Overview and HeapQL only. Select the trusted hprof-server executable.");
    private final JButton choose = new JButton("Select analysis server");
    private final JButton retry = new JButton("Retry");
    private final HeapSession session;
    private HeapBrowser browser;
    private volatile Path binary;
    private volatile boolean ready, disposed;

    public HeapEditor(Project project, VirtualFile file) {
        this.file = file;
        // Explicit launch configuration, never an executable path supplied by a workspace.
        String configured = System.getProperty("heaplens.server.path");
        if (configured != null && !configured.isBlank()) binary = Path.of(configured);
        session = new HeapSession(() -> {
            if (binary == null) throw new IllegalStateException("Select a trusted server");
            return new JsonLineRpcClient(binary);
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
        if (!JBCefApp.isSupported()) {
            choose.setEnabled(false);
            panel.add(new JLabel("JCEF unavailable. Run this prototype with the supported JetBrains Runtime."), BorderLayout.CENTER);
            return;
        }
        try {
            CommandRouter router = CommandRouter.forSession(session, () -> {
                ready = true;
                if (binary != null) session.start();
            });
            browser = new HeapBrowser(raw -> router.dispatch(raw));
            Disposer.register(this, browser);
            panel.add(browser.component(), BorderLayout.CENTER);
        } catch (Exception e) {
            choose.setEnabled(false);
            panel.add(new JLabel("Could not initialize HeapLens web UI. Check the prototype build."), BorderLayout.CENTER);
        }
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
