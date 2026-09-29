package com.heaplens.session;

import com.heaplens.intellij.PageOrigin;
import com.intellij.ui.jcef.JBCefFileSchemeHandlerFactory;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PageOriginTest {
    @Test void pinnedSdkPreservesTheExplicitVirtualFileUrl() {
        PageOrigin origin = new PageOrigin();
        // The SDK rewrites about:blank to a generated file URL.
        assertEquals(origin.url(), JBCefFileSchemeHandlerFactory.makeFileUrl(origin.url()));
        assertTrue(origin.allowsNavigation(JBCefFileSchemeHandlerFactory.makeFileUrl(origin.url())));
        assertNotEquals("about:blank", JBCefFileSchemeHandlerFactory.makeFileUrl("about:blank"));
    }
    @Test void navigationCannotEscapeToNetworkOrOtherLocalFiles() {
        PageOrigin origin = new PageOrigin();
        for (String target : new String[] {null,"https://example.com","file:///etc/passwd","javascript:alert(1)",
            origin.url() + "?x", origin.url() + "/../secret", new PageOrigin().url()})
            assertFalse(origin.allowsNavigation(target));
    }
    @Test void everyEditorHasAnIndependentVirtualOrigin() {
        PageOrigin a = new PageOrigin(), b = new PageOrigin();
        assertNotEquals(a.url(), b.url()); assertTrue(a.allowsNavigation(a.url()));
        assertTrue(a.allowsNavigation("about:blank")); assertFalse(a.allowsNavigation(b.url()));
    }
}
