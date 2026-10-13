package com.heaplens.intellij;

import com.intellij.ide.util.PropertiesComponent;
import javax.swing.JCheckBox;

/** Local initial-mode preference; failure to persist never prevents editor startup. */
final class QuickScanPreference {
    private QuickScanPreference() { }
    private static PropertiesComponent preferences() {
        try{return PropertiesComponent.getInstance();}catch(RuntimeException unavailable){return null;}
    }
    static JCheckBox control() {
        PropertiesComponent prefs=preferences();
        boolean selected=false;
        if(prefs!=null)try{selected=prefs.getBoolean("heaplens.quickScanFirst",false);}catch(RuntimeException unavailable){/* Default full mode. */}
        JCheckBox control=new JCheckBox("Quick Scan first",selected);
        control.setToolTipText("Use shallow scanning for newly opened dumps. Analyze Retained is a separate explicit action.");
        control.addActionListener(e->{if(prefs!=null)try{prefs.setValue("heaplens.quickScanFirst",control.isSelected(),false);}catch(RuntimeException unavailable){/* Selection still applies to this editor. */}});
        return control;
    }
}
