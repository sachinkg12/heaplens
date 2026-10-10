package com.heaplens.intellij;

import com.heaplens.ai.*;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.DialogWrapper;
import com.intellij.ui.components.JBPasswordField;
import java.awt.*;
import java.util.Arrays;
import javax.swing.*;
import org.jetbrains.annotations.Nullable;

/** Native-only credential input; the page cannot read this field or request the stored key. */
final class AiSettingsDialog extends DialogWrapper {
    enum KeyAction { KEEP, REPLACE, CLEAR }
    private final JComboBox<AiProviders.Provider> providers=new JComboBox<>(AiProviders.all().toArray(AiProviders.Provider[]::new));
    private final JTextField endpoint=new JTextField(44),model=new JTextField(44);
    private final JComboBox<String> action=new JComboBox<>(new String[]{"Keep key for this provider + endpoint","Replace key for this provider + endpoint","Clear key for this provider + endpoint"});
    private final JBPasswordField key=new JBPasswordField();
    private final JCheckBox reveal=new JCheckBox("Show");
    private AiConfiguration.Settings settings;
    private char[] replacement;
    AiSettingsDialog(@Nullable Project project,AiConfiguration.Settings current) {
        super(project,true);setTitle("HeapLens: Configure AI Chat");setOKButtonText("Save");
        providers.setRenderer(new DefaultListCellRenderer() {
            @Override public Component getListCellRendererComponent(JList<?> list,Object value,int index,boolean selected,boolean focused) {
                return super.getListCellRendererComponent(list,value instanceof AiProviders.Provider p ? p.label() : "",index,selected,focused);
            }
        });
        providers.setSelectedItem(AiProviders.get(current.provider()));endpoint.setText(current.baseUrl());model.setText(current.model());
        providers.addActionListener(e -> {
            AiProviders.Provider provider=(AiProviders.Provider)providers.getSelectedItem();
            endpoint.setText(provider.defaultBaseUrl());model.setText(provider.defaultModel());key.setText("");reveal.setSelected(false);
            key.setEchoChar('•');
        });
        key.setEnabled(false);reveal.setEnabled(false);
        action.addActionListener(e -> {boolean replace=action.getSelectedIndex()==1;key.setEnabled(replace);reveal.setEnabled(replace);reveal.setSelected(false);key.setEchoChar('•');if(!replace) key.setText("");});
        char echo=key.getEchoChar();reveal.addActionListener(e -> key.setEchoChar(reveal.isSelected() ? (char)0 : echo));
        init();
    }
    @Override protected JComponent createCenterPanel() {
        JPanel panel=new JPanel(new GridBagLayout());GridBagConstraints c=new GridBagConstraints();
        c.gridx=0;c.gridy=0;c.fill=GridBagConstraints.HORIZONTAL;c.weightx=1;c.insets=new Insets(4,0,4,0);
        for(JComponent component:new JComponent[]{new JLabel("Provider"),providers,new JLabel("Base URL (not the full chat/completions URL)"),endpoint,
            new JLabel("Model ID (must be available in your account or local server)"),model,new JLabel("API key"),action}) {panel.add(component,c);c.gridy++;}
        JPanel password=new JPanel(new BorderLayout(8,0));password.add(key,BorderLayout.CENTER);password.add(reveal,BorderLayout.EAST);panel.add(password,c);c.gridy++;
        JTextArea note=new JTextArea("Keys use IntelliJ Password Safe, not project files or the webview. Storage may be memory-only, depending on IDE settings.\n"
            +"Stored keys are not displayed. Replace or clear them here. Keys are scoped to the provider and base URL.\n"
            +"Ollama can run without a key. Every send asks for approval; local endpoints may forward requests elsewhere.");
        note.setEditable(false);note.setLineWrap(true);note.setWrapStyleWord(true);note.setOpaque(false);note.setRows(5);
        panel.add(note,c);return panel;
    }
    @Override protected void doOKAction() {
        char[] entered=key.getPassword();
        try {
            settings=new AiConfiguration.Settings(((AiProviders.Provider)providers.getSelectedItem()).id(),endpoint.getText(),model.getText());
            if(keyAction()==KeyAction.REPLACE) {
                new AiConfiguration(settings,new String(entered));
                if(entered.length==0) throw new IllegalArgumentException("Enter a replacement key, or select Clear.");
                replacement=entered.clone();
            }
            super.doOKAction();
        } catch(IllegalArgumentException invalid) {setErrorText(invalid.getMessage());}
        finally {Arrays.fill(entered,'\0');}
    }
    AiConfiguration.Settings settings() {return settings;}
    KeyAction keyAction() {return KeyAction.values()[action.getSelectedIndex()];}
    char[] replacement() {return replacement;}
    void clearInput() {key.setText("");if(replacement!=null) Arrays.fill(replacement,'\0');}
}
