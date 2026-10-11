package com.heaplens.intellij;

import java.awt.Color;
import javax.swing.UIManager;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class HeapAppearanceTest {
    @Test void nativeColorsAreOpaqueAndTheWireContainsNoPathsOrCredentials() {
        var appearance=HeapAppearance.current();
        assertEquals("hostAppearance",appearance.get("command").getAsString());
        assertTrue(appearance.get("dark").getAsJsonPrimitive().isBoolean());
        var colors=appearance.getAsJsonObject("colors");assertEquals(16,colors.size());
        assertNotEquals(colors.get("--vscode-editorError-foreground"),colors.get("--vscode-editorWarning-foreground"));
        assertTrue(HeapAppearance.initialCss().contains("--vscode-editorWarning-foreground:"));
        colors.entrySet().forEach(entry->assertTrue(entry.getValue().getAsString().matches("#[0-9a-f]{6}")));
        assertFalse(appearance.toString().contains("path"));
        assertTrue(HeapAppearance.initialCss().startsWith(":root{color-scheme:"));
    }
    @Test void customNativePanelColorIsUsedInsteadOfForcedDarkPalette() {
        Object before=UIManager.get("Panel.background");
        try {
            UIManager.put("Panel.background",new Color(0x123456));
            assertEquals("#123456",HeapAppearance.current().getAsJsonObject("colors").get("--vscode-editor-background").getAsString());
        } finally {UIManager.put("Panel.background",before);}
    }
}
