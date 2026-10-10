package com.heaplens.intellij;

import com.google.gson.JsonObject;
import com.intellij.openapi.Disposable;
import java.util.function.Consumer;
import javax.swing.JComponent;

/** Browser-free editor boundary, so a missing JCEF module can still render a Swing error. */
interface HeapView extends Disposable {
    JComponent component();
    void send(JsonObject event);

    @FunctionalInterface
    interface Factory {
        /** Returns null when the runtime does not support the browser. */
        HeapView create(Consumer<String> messages) throws Exception;
    }
}
