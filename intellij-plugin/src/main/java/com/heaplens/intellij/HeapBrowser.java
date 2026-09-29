package com.heaplens.intellij;

import com.google.gson.*;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.util.Disposer;
import com.intellij.ui.jcef.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.function.Consumer;
import javax.swing.JComponent;
import org.cef.browser.*;
import org.cef.network.CefRequest;
import org.cef.handler.*;

/** JCEF presentation adapter. No process lifecycle or analysis policy. */
public final class HeapBrowser implements Disposable {
    private final JBCefBrowser browser;
    private final JBCefJSQuery bridge;
    private final PageOrigin origin = new PageOrigin();
    private volatile boolean disposed;
    public HeapBrowser(Consumer<String> messages) throws IOException {
        String html;
        try (var input = HeapBrowser.class.getResourceAsStream("/webview/index.html")) {
            if (input == null) throw new IOException("Missing generated webview");
            html = new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
        browser = new JBCefBrowser();
        bridge = JBCefJSQuery.create((JBCefBrowserBase) browser);
        Disposer.register(this, browser);
        Disposer.register(this, bridge);
        browser.getJBCefClient().addRequestHandler(new CefRequestHandlerAdapter() {
            @Override public boolean onBeforeBrowse(CefBrowser b, CefFrame f, CefRequest r, boolean gesture, boolean redirect) {
                return !origin.allowsNavigation(r.getURL());
            }
            @Override public boolean onOpenURLFromTab(CefBrowser b, CefFrame f, String url, boolean gesture) { return true; }
        }, browser.getCefBrowser());
        browser.getJBCefClient().addLifeSpanHandler(new CefLifeSpanHandlerAdapter() {
            @Override public boolean onBeforePopup(CefBrowser b, CefFrame f, String url, String name) { return true; }
        }, browser.getCefBrowser());
        bridge.addHandler(raw -> { messages.accept(raw); return null; });
        html = html.replace("__NONCE__", UUID.randomUUID().toString().replace("-", ""))
            .replace("__BRIDGE__", bridge.inject("JSON.stringify(message)"));
        browser.loadHTML(html, origin.url());
    }
    public JComponent component() { return browser.getComponent(); }
    public void send(JsonObject event) {
        // JSON inside a JSON-encoded string: heap strings cannot become executable JS.
        String script = "window.dispatchEvent(new MessageEvent('message',{data:JSON.parse("
            + new Gson().toJson(event.toString()) + ")}));";
        ApplicationManager.getApplication().invokeLater(() -> {
            if (!disposed) browser.getCefBrowser().executeJavaScript(script, browser.getCefBrowser().getURL(), 0);
        });
    }
    @Override public void dispose() { disposed = true; }
}
