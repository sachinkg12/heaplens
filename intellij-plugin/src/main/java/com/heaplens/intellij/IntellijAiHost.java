package com.heaplens.intellij;

import com.heaplens.ai.*;
import com.intellij.credentialStore.*;
import com.intellij.ide.passwordSafe.PasswordSafe;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.DialogWrapper;
import com.intellij.openapi.util.Disposer;
import com.intellij.util.concurrency.AppExecutorUtil;
import java.awt.BorderLayout;
import java.util.Arrays;
import java.util.function.*;
import javax.swing.*;

/** Host-only settings, secure storage and explicit approval. Never logs exceptions or request data. */
final class IntellijAiHost implements AiHostPort {
    private final Project project;
    private final Disposable owner;
    IntellijAiHost(Project project,Disposable owner) {this.project=project;this.owner=owner;}
    private AiPreferences preferences() {return ApplicationManager.getApplication().getService(AiPreferences.class);}
    public AiConfiguration loadConfiguration() {
        AiConfiguration.Settings settings=preferences().snapshot();
        String key=PasswordSafe.getInstance().getPassword(new CredentialAttributes(settings.credentialId()));
        return new AiConfiguration(settings,key);
    }
    public void configure(BooleanSupplier active,Consumer<String> status) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if(!active.getAsBoolean()) return;
            AiSettingsDialog dialog=null;
            Disposable closer=null;
            try {
                AiConfiguration.Settings current;
                try {current=preferences().snapshot();} catch(RuntimeException invalid) {current=new AiConfiguration.Settings("openai","","");}
                dialog=new AiSettingsDialog(project,current);
                AiSettingsDialog owned=dialog;
                closer=() -> {if(!owned.isDisposed()) owned.close(DialogWrapper.CANCEL_EXIT_CODE);};
                Disposer.register(owner,closer);
                if(!dialog.showAndGet() || !active.getAsBoolean()) {status.accept("AI configuration cancelled.");return;}
                AiConfiguration.Settings chosen=dialog.settings();
                AiSettingsDialog.KeyAction action=dialog.keyAction();
                char[] key=dialog.replacement()==null ? new char[0] : dialog.replacement().clone();
                AppExecutorUtil.getAppExecutorService().execute(() -> {
                    try {
                        if(!active.getAsBoolean()) return;
                        PasswordSafe safe=PasswordSafe.getInstance();
                        CredentialAttributes scope=new CredentialAttributes(chosen.credentialId());
                        if(action==AiSettingsDialog.KeyAction.REPLACE) safe.set(scope,new Credentials("api-key",key));
                        else if(action==AiSettingsDialog.KeyAction.CLEAR) safe.set(scope,null);
                        preferences().save(chosen);
                        status.accept("Configured "+AiProviders.get(chosen.provider()).label()+" · "+chosen.model()+" · "+chosen.endpoint()
                            +(safe.isMemoryOnly() ? " · Password Safe is memory-only in this IDE session." : " · Credentials handled by IntelliJ Password Safe."));
                    } catch(RuntimeException failure) {status.accept("AI settings could not be saved. Check IntelliJ Password Safe and try again.");}
                    finally {Arrays.fill(key,'\0');}
                });
            } catch(RuntimeException failure) {status.accept("AI configuration is unavailable. Check the IDE Password Safe settings.");}
            finally {if(dialog!=null) dialog.clearInput();if(closer!=null) Disposer.dispose(closer);}
        });
    }
    public void confirm(AiConfiguration.Settings settings,boolean hasHistory,BooleanSupplier active,Consumer<Boolean> reply) {
        confirm(settings,hasHistory,false,active,reply);
    }
    public void confirmChatSession(AiConfiguration.Settings settings,boolean hasHistory,BooleanSupplier active,Consumer<Boolean> reply) {
        confirm(settings,hasHistory,true,active,reply);
    }
    private void confirm(AiConfiguration.Settings settings,boolean hasHistory,boolean chatSession,BooleanSupplier active,Consumer<Boolean> reply) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if(!active.getAsBoolean()) return;
            Disposable closer=null;
            try {
                String message=(chatSession ? "Allow AI Chat in this heap-dump editor to send to:\n" : "Send this AI request to:\n")+settings.endpoint()+"\n\nProvider: "+AiProviders.get(settings.provider()).label()+
                    "\nModel: "+settings.model()+"\n\nIncludes your question"+(chatSession || hasHistory ? ", recent successful conversation history" : "")+
                    ", heap counts/sizes, selected class/field names and suspect metrics.\n\n"
                    +(chatSession ? "Later Send clicks in this chat session will use this approval without another popup. "
                        +"Clear, Configure AI, Retry, closing/reopening the dump, or changing the provider, endpoint, model or key requires approval again. "
                        +"Approval is not saved or shared with other dump editors. Explain and Fix with AI still ask separately.\n\n" : "")
                    +"No automatic raw string/primitive values, source files or local paths are included. Names and text you type may still be sensitive. "
                    +"Local endpoints can forward data elsewhere. Provider charges and data policies may apply.\n\n"
                    +"AI suggestions may be wrong. They do not execute queries or change files.";
                DialogWrapper dialog=new DialogWrapper(project,true) {
                    {setTitle(chatSession ? "HeapLens: Allow AI Chat for This Session?" : "HeapLens: Send Heap Metadata to AI?");setOKButtonText(chatSession ? "Allow for This Session" : "Send");init();}
                    protected JComponent createCenterPanel() {
                        JTextArea text=new JTextArea(message,chatSession ? 23 : 17,58);text.setEditable(false);text.setLineWrap(true);text.setWrapStyleWord(true);text.setCaretPosition(0);
                        JPanel panel=new JPanel(new BorderLayout());panel.add(new JScrollPane(text));return panel;
                    }
                };
                closer=() -> {if(!dialog.isDisposed()) dialog.close(DialogWrapper.CANCEL_EXIT_CODE);};
                Disposer.register(owner,closer);
                boolean approved=dialog.showAndGet();
                if(active.getAsBoolean()) reply.accept(approved);
            } catch(RuntimeException failure) {if(active.getAsBoolean()) reply.accept(false);}
            finally {if(closer!=null) Disposer.dispose(closer);}
        });
    }
}
