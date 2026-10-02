package com.heaplens.intellij;

import com.google.gson.JsonObject;
import com.intellij.openapi.progress.ProcessCanceledException;
import com.intellij.openapi.util.Disposer;
import com.intellij.testFramework.LightVirtualFile;
import java.awt.Component;
import java.awt.Container;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import javax.swing.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class HeapEditorStartupTest {
    private HeapEditor editor(HeapView.Factory factory) {
        return new HeapEditor(null, new LightVirtualFile("test.hprof"), null, factory);
    }
    private List<Component> descendants(Container root) {
        List<Component> result = new ArrayList<>();
        for (Component child : root.getComponents()) {
            result.add(child);
            if (child instanceof Container container) result.addAll(descendants(container));
        }
        return result;
    }
    private void assertUnavailable(HeapView.Factory factory) {
        HeapEditor editor = assertDoesNotThrow(() -> editor(factory));
        try {
            var components = descendants(editor.getComponent());
            assertTrue(components.stream().filter(c -> c instanceof JLabel)
                .map(c -> ((JLabel)c).getText()).anyMatch(t -> t.contains("UI unavailable | analysis not started")));
            assertTrue(components.stream().filter(c -> c instanceof JLabel)
                .map(c -> ((JLabel)c).getText()).anyMatch(t -> t.contains("embedded browser (JCEF)")));
            assertEquals(2, components.stream().filter(c -> c instanceof JButton).count());
            assertTrue(components.stream().filter(c -> c instanceof JButton).noneMatch(Component::isEnabled));
        } finally { Disposer.dispose(editor); }
    }
    @Test void missingBrowserClassShowsActionableFallbackInsteadOfBlankEditor() {
        assertUnavailable(messages -> { throw new NoClassDefFoundError("com/intellij/ui/jcef/JBCefApp"); });
    }
    @Test void nativeBrowserLinkageFailureShowsFallback() {
        assertUnavailable(messages -> { throw new UnsatisfiedLinkError("JCEF native library unavailable"); });
    }
    @Test void unsupportedRuntimeShowsFallback() { assertUnavailable(messages -> null); }
    @Test void ordinaryInitializationFailureShowsFallback() {
        assertUnavailable(messages -> { throw new IOException("Missing generated webview"); });
    }
    @Test void platformCancellationIsNotDisguisedAsBrowserFailure() {
        assertThrows(ProcessCanceledException.class, () -> editor(messages -> { throw new ProcessCanceledException(); }));
    }
    @Test void vmFailureIsNotSwallowed() {
        assertThrows(OutOfMemoryError.class, () -> editor(messages -> { throw new OutOfMemoryError("synthetic"); }));
    }
    private static final class FailingView implements HeapView {
        final RuntimeException failure;
        boolean disposed;
        FailingView(RuntimeException failure) { this.failure = failure; }
        public JComponent component() { throw failure; }
        public void send(JsonObject event) { }
        public void dispose() { disposed = true; }
    }
    @Test void partiallyMountedViewIsDisposedOnFailure() {
        var view = new FailingView(new IllegalStateException("synthetic mount failure"));
        assertUnavailable(messages -> view);
        assertTrue(view.disposed);
    }
    @Test void partiallyMountedViewIsDisposedOnPlatformCancellation() {
        var view = new FailingView(new ProcessCanceledException());
        assertThrows(ProcessCanceledException.class, () -> editor(messages -> view));
        assertTrue(view.disposed);
    }
    @Test void workingViewIsMountedAndDisposedWithItsEditor() {
        class View implements HeapView {
            final JPanel component = new JPanel();
            boolean disposed;
            public JComponent component() { return component; }
            public void send(JsonObject event) { }
            public void dispose() { disposed = true; }
        }
        View view = new View();
        HeapEditor editor = editor(messages -> view);
        assertSame(view.component, editor.getPreferredFocusedComponent());
        assertTrue(descendants(editor.getComponent()).contains(view.component));
        Disposer.dispose(editor);
        assertTrue(view.disposed);
    }
}
