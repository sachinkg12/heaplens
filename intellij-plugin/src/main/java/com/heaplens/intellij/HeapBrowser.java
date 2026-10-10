package com.heaplens.intellij;

import com.google.gson.*;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.ide.ui.LafManagerListener;
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
public final class HeapBrowser implements HeapView {
    private final JBCefBrowser browser;
    private final JBCefJSQuery bridge;
    private final PageOrigin origin = new PageOrigin();
    private volatile boolean disposed;
    static HeapView open(Consumer<String> messages) throws IOException {
        return JBCefApp.isSupported() ? new HeapBrowser(messages) : null;
    }
    public HeapBrowser(Consumer<String> messages) throws IOException {
        String html;
        try (var input = HeapBrowser.class.getResourceAsStream("/webview/index.html")) {
            if (input == null) throw new IOException("Missing generated webview");
            html = new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
        browser = new JBCefBrowser();
        Disposer.register(this, browser);
        try {
            bridge = JBCefJSQuery.create((JBCefBrowserBase) browser);
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
            bridge.addHandler(raw -> {
                // Page-ready handshake avoids losing the initial palette while HTML loads.
                try {
                    var message = JsonParser.parseString(raw).getAsJsonObject();
                    if (message.has("command") && "ready".equals(message.get("command").getAsString()))
                        ApplicationManager.getApplication().invokeLater(() -> send(HeapAppearance.current()));
                } catch (RuntimeException ignored) { /* The command router rejects malformed input. */ }
                messages.accept(raw); return null;
            });
            ApplicationManager.getApplication().getMessageBus().connect(this)
                .subscribe(LafManagerListener.TOPIC, manager -> send(HeapAppearance.current()));
            html = html.replace("__NONCE__", UUID.randomUUID().toString().replace("-", ""))
                .replace("__BRIDGE__", bridge.inject("JSON.stringify(message)"));
            html = html.replace("</head>","<style>"+HeapAppearance.initialCss()+"</style></head>");
            browser.loadHTML(html, origin.url());
        } catch (RuntimeException | LinkageError failure) {
            // A constructor that fails never reaches the editor's disposal registration.
            Disposer.dispose(this);
            throw failure;
        }
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
