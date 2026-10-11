package com.heaplens.intellij;

import com.google.gson.JsonObject;
import com.intellij.ui.JBColor;
import java.awt.Color;
import javax.swing.UIManager;

/** Native appearance is a presentation concern, never an analyzer setting. */
final class HeapAppearance {
    private HeapAppearance() { }
    static String initialCss() {
        JsonObject event=current();
        StringBuilder css=new StringBuilder(":root{color-scheme:").append(event.get("dark").getAsBoolean()?"dark;":"light;");
        event.getAsJsonObject("colors").entrySet().forEach(entry->css.append(entry.getKey()).append(':').append(entry.getValue().getAsString()).append(';'));
        return css.append('}').toString();
    }
    static JsonObject current() {
        boolean dark = !JBColor.isBright();
        JsonObject event = new JsonObject();
        event.addProperty("command", "hostAppearance");
        event.addProperty("dark", dark);
        JsonObject colors = new JsonObject();
        put(colors, "--vscode-editor-background", "Panel.background", dark ? 0x202124 : 0xffffff);
        put(colors, "--vscode-foreground", "Label.foreground", dark ? 0xededed : 0x202124);
        put(colors, "--vscode-editor-foreground", "Label.foreground", dark ? 0xededed : 0x202124);
        put(colors, "--vscode-editorGroupHeader-tabsBackground", "Panel.background", dark ? 0x202124 : 0xf4f5f7);
        put(colors, "--vscode-editorWidget-background", "Table.background", dark ? 0x28292c : 0xf4f5f7);
        put(colors, "--vscode-list-hoverBackground", "List.selectionBackground", dark ? 0x343539 : 0xe5edfa);
        put(colors, "--vscode-panel-border", "Component.borderColor", dark ? 0x505050 : 0xc4c7cc);
        put(colors, "--vscode-input-background", "TextField.background", dark ? 0x303134 : 0xffffff);
        put(colors, "--vscode-input-foreground", "TextField.foreground", dark ? 0xededed : 0x202124);
        put(colors, "--vscode-input-border", "Component.borderColor", dark ? 0x707070 : 0xa4a8ae);
        colors.addProperty("--vscode-button-background", dark ? "#176ac5" : "#1264bc");
        colors.addProperty("--vscode-button-foreground", "#ffffff");
        colors.addProperty("--vscode-focusBorder", dark ? "#6baaff" : "#1264bc");
        colors.addProperty("--vscode-editorError-foreground", dark ? "#ff7777" : "#b42318");
        // Amber on light surfaces retains contrast; bright yellow works on dark surfaces.
        colors.addProperty("--vscode-editorWarning-foreground", dark ? "#f2c55c" : "#946200");
        colors.addProperty("--hl-scrollbar-thumb", dark ? "#969aa3" : "#747b85");
        event.add("colors", colors);
        return event;
    }
    private static void put(JsonObject colors, String token, String nativeKey, int fallback) {
        Color value = UIManager.getColor(nativeKey);
        colors.addProperty(token, String.format("#%06x", (value == null ? fallback : value.getRGB()) & 0xffffff));
    }
}
