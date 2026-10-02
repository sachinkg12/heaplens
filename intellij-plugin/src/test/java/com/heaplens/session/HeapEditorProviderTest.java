package com.heaplens.session;

import com.heaplens.intellij.HeapEditorProvider;
import com.intellij.openapi.fileEditor.FileEditorPolicy;
import com.intellij.openapi.project.DumbService;
import com.intellij.openapi.extensions.PluginAware;
import org.junit.jupiter.api.Test;
import javax.xml.parsers.DocumentBuilderFactory;
import static org.junit.jupiter.api.Assertions.*;

class HeapEditorProviderTest {
    @Test void splitBrowserDependencyIsDeclaredWithoutDroppingOlderCoreBrowserIdeSupport() throws Exception {
        var parser = DocumentBuilderFactory.newInstance().newDocumentBuilder();
        try (var input = getClass().getResourceAsStream("/META-INF/plugin.xml")) {
            var document = parser.parse(input);
            var dependencies = document.getElementsByTagName("depends");
            org.w3c.dom.Element browserDependency = null;
            for (int i = 0; i < dependencies.getLength(); i++) {
                var element = (org.w3c.dom.Element) dependencies.item(i);
                if (element.getTextContent().trim().equals("com.intellij.modules.jcef")) browserDependency = element;
            }
            assertNotNull(browserDependency, "Newer IDEs isolate JCEF in a bundled plugin classloader");
            assertEquals("true", browserDependency.getAttribute("optional"), "Older IDEs provide JCEF in core");
            String descriptor = browserDependency.getAttribute("config-file");
            assertEquals("heaplens-jcef.xml", descriptor);
            try (var optional = getClass().getResourceAsStream("/META-INF/" + descriptor)) {
                assertNotNull(optional, "Optional dependency descriptor must ship in the plugin");
                assertEquals("idea-plugin", parser.parse(optional).getDocumentElement().getTagName());
            }
        }
    }
    @Test void providerReceivesInstallationMetadataThroughThePublicExtensionContract() {
        assertTrue(PluginAware.class.isAssignableFrom(HeapEditorProvider.class));
    }
    @Test void hidingTheDefaultEditorSatisfiesTheSdkIndexingContract() {
        HeapEditorProvider provider = new HeapEditorProvider();
        assertEquals(FileEditorPolicy.HIDE_DEFAULT_EDITOR, provider.getPolicy());
        // Use the same SDK predicate as FileEditorProviderManagerImpl.checkPolicy.
        assertTrue(DumbService.isDumbAware(provider),
            "HIDE_DEFAULT_EDITOR providers must be available without project indexes");
    }
}
