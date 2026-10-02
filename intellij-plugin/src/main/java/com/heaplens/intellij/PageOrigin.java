package com.heaplens.intellij;

import java.util.UUID;

/** Exact virtual URL registered with JCEF; this is not a file read or a web server. */
public final class PageOrigin {
    private final String url = "file:///heaplens-prototype-" + UUID.randomUUID() + "/index.html";
    public String url() { return url; }
    public boolean allowsNavigation(String target) { return url.equals(target) || "about:blank".equals(target); }
}
