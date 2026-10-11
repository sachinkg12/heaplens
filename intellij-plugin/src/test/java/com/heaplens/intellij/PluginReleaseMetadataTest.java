package com.heaplens.intellij;

import java.nio.charset.StandardCharsets;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PluginReleaseMetadataTest {
    private static String resource(String name) throws Exception {
        try (var stream = PluginReleaseMetadataTest.class.getResourceAsStream(name)) {
            assertNotNull(stream, "Missing release resource: " + name);
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
    @Test void descriptorKeepsStableIdentityAndAccurateReleaseScope() throws Exception {
        var factory = DocumentBuilderFactory.newInstance();
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        try (var stream = getClass().getResourceAsStream("/META-INF/plugin.xml")) {
            assertNotNull(stream);
            var xml = factory.newDocumentBuilder().parse(stream);
            assertEquals("HeapLens", xml.getElementsByTagName("name").item(0).getTextContent());
            assertEquals("com.heaplens.analyzer", xml.getElementsByTagName("id").item(0).getTextContent());
            assertEquals(IntellijTelemetry.packagedVersion(), xml.getElementsByTagName("version").item(0).getTextContent());
            assertTrue(IntellijTelemetry.packagedVersion().matches("[0-9]+\\.[0-9]+\\.[0-9]+"));
            var range = xml.getElementsByTagName("idea-version").item(0).getAttributes();
            assertEquals("261", range.getNamedItem("since-build").getNodeValue());
            assertEquals("262.*", range.getNamedItem("until-build").getNodeValue());
            String description = xml.getElementsByTagName("description").item(0).getTextContent();
            assertTrue(description.contains("off until you explicitly enable"));
            assertTrue(description.contains("entire approved project source file"));
            assertFalse(description.contains("Not a published"));
            assertFalse(description.contains("Local development preview"));
            assertTrue(xml.getElementsByTagName("change-notes").getLength() == 1);
            assertTrue(resource("/META-INF/plugin.xml").contains("com.intellij.modules.os.mac"));
            assertTrue(resource("/META-INF/plugin.xml").contains("com.intellij.modules.arch.arm64"));
        }
    }
    @Test void iconIsFortyPixelSelfContainedVectorAndNoticesArePresent() throws Exception {
        String icon = resource("/META-INF/pluginIcon.svg");
        assertTrue(icon.contains("width=\"40\""));
        assertTrue(icon.contains("height=\"40\""));
        assertFalse(icon.contains("<image"));
        assertFalse(icon.contains("<text"));
        assertFalse(icon.contains("<filter"));
        String notices = resource("/META-INF/THIRD-PARTY-NOTICES.txt");
        for (String component : new String[]{"Gson 2.13.1", "Error Prone annotations 2.38.0", "Mike Bostock", "licenses/rust/"})
            assertTrue(notices.contains(component));
    }
    @Test void brandIconLoadsThroughTheIdeIconLoader() {
        var icon = com.intellij.openapi.util.IconLoader.getIcon("/META-INF/pluginIcon.svg", getClass());
        assertEquals(40, icon.getIconWidth());
        assertEquals(40, icon.getIconHeight());
    }
}
